// The merged Provider+Model picker's option model.
//
// The launch dialogs used to carry two dropdowns, Provider and Model, in that
// order. That is one step more than the decision actually has: nobody chooses a
// vendor as an act separate from choosing a model, and the pair could be left
// inconsistent in between (a Codex model id showing under Claude) which the fork
// dialog then had to defend against.
//
// So the control is one menu, grouped by provider, and picking a model reports
// BOTH values at once. The consistency rule that used to live in field-change
// handlers becomes structural: an option cannot name a model without also naming
// the provider whose catalog it came from.

import { buildModelSelectOptions } from "./composer.js";
import { providerLabel } from "./provider-labels.js";

// Shown when the dialog holds no explicit model — the relay will resolve the
// provider's default. Saying "default" is honest about that; naming a concrete
// model would claim a choice the request does not actually carry.
const DEFAULT_MODEL_LABEL = "default";

function catalogFor(providerModels, provider) {
  return providerModels?.[provider] || [];
}

function modelEntry(models, model) {
  return (models || []).find((entry) => entry?.model === model) || null;
}

export function buildModelPickerGroups({
  providerModels = {},
  providers = [],
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  return (providers || []).map((provider) => {
    const models = catalogFor(providerModels, provider);
    const isSelectedProvider = provider === selectedProvider;
    // Only the SELECTED provider's group gets the current value forced into it.
    // Passing it to every group would surface a Claude id under Codex — the exact
    // cross-provider leak `buildModelSelectOptions`' `allowForeign: false` mode
    // exists to prevent — and would tick two rows for one choice.
    const { options } = buildModelSelectOptions(
      models,
      isSelectedProvider ? selectedModel : "",
      { allowForeign: true }
    );

    const rendered = options.map((option) => ({
      label: option.display_name || option.model,
      provider,
      selected: isSelectedProvider && option.model === selectedModel,
      tag: option.is_default ? "default" : null,
      value: option.model,
    }));

    return {
      // `empty` marks a provider whose catalogue has not arrived (cold worker,
      // failed fetch) — but the group still gets a CHOOSABLE row. Rendering the
      // provider with zero options and a "No models available" note read as
      // "offered but disabled", and stranded the user on their current provider
      // even though the relay is perfectly able to start that one on its own
      // default model. The row carries an empty model id, which is exactly what
      // "let the relay resolve it" looks like on the wire.
      empty: rendered.length === 0,
      label: providerLabel(provider),
      options: rendered.length
        ? rendered
        : [
            {
              label: "Use provider default",
              provider,
              selected: isSelectedProvider && !selectedModel,
              tag: null,
              value: "",
            },
          ],
      provider,
    };
  });
}

// What the closed pill reads: "Claude · Opus 4.6", plus the "default" tag when
// the chosen model is the provider's default. Provider and model together,
// because after the merge the pill is the only thing naming the provider at all.
export function selectedModelChip({
  providerModels = {},
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  const name = providerLabel(selectedProvider);
  const entry = modelEntry(catalogFor(providerModels, selectedProvider), selectedModel);
  const modelText = selectedModel
    ? entry?.display_name || selectedModel
    : DEFAULT_MODEL_LABEL;

  return {
    tag: entry?.is_default ? "default" : null,
    value: name ? `${name} · ${modelText}` : modelText,
  };
}
