import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { buildModelSelectOptions } from "./composer.js";

const h = React.createElement;
const rootsBySelect = new WeakMap();
const renderStateBySelect = new WeakMap();

export function renderSelectOptions(select, options = [], selectedValue = "") {
  if (!select) {
    return;
  }

  const nextState = {
    optionsKey: JSON.stringify(
      options.map((option) => ({
        label: option.label,
        provider: option.provider || "",
        value: option.value,
      }))
    ),
    selectedValue,
  };
  const previousState = renderStateBySelect.get(select);
  if (
    previousState?.optionsKey === nextState.optionsKey
    && previousState?.selectedValue === nextState.selectedValue
  ) {
    return;
  }

  let root = rootsBySelect.get(select);
  if (!root) {
    root = createRoot(select);
    rootsBySelect.set(select, root);
  }

  flushSync(() => {
    root.render(
      h(
        React.Fragment,
        null,
        ...options.map((option) =>
          h(
            "option",
            {
              key: option.value,
              value: option.value,
              // Lets a picker's logo slot resolve the selected vendor straight
              // from the DOM, with no parallel lookup table to keep in sync.
              "data-provider": option.provider || undefined,
            },
            option.label
          )
        )
      )
    );
  });

  select.value = selectedValue;
  renderStateBySelect.set(select, nextState);
}

export function replaceSelectOptions(select, options = [], selectedValue = "") {
  if (!select) {
    return;
  }

  const current = [...select.options];
  const sameOptions =
    current.length === options.length
    && current.every(
      (option, index) =>
        option.value === options[index]?.value
        && option.textContent === options[index]?.label
        && (option.dataset.provider || "") === (options[index]?.provider || "")
    );
  if (!sameOptions) {
    const nodes = options.map((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      if (option.provider) {
        node.dataset.provider = option.provider;
      }
      return node;
    });
    select.replaceChildren(...nodes);
  }
  if (select.value !== selectedValue) {
    select.value = selectedValue;
  }
}

// Imperative model-control path used by the local surface. Keeping it here
// makes the exact DOM update independently testable, including the cached
// same-provider catalogue used during an empty session snapshot.
export function syncModelSuggestions(
  select,
  models,
  selectedModel,
  allowForeign = false,
  replaceExisting = false,
  fallbackModels = []
) {
  if (!select) {
    return;
  }

  const { options, value: currentValue } = buildModelSelectOptions(
    models,
    selectedModel || select.value || "",
    { allowForeign, fallbackModels }
  );
  const renderedOptions = options.map((model) => ({
    label: model.display_name || model.model,
    provider: model.provider || "",
    value: model.model,
  }));

  if (replaceExisting) {
    replaceSelectOptions(select, renderedOptions, currentValue);
  } else {
    renderSelectOptions(select, renderedOptions, currentValue);
  }
}
