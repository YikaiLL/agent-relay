import test from "node:test";
import assert from "node:assert/strict";

import { attachTranscriptHistoryLoader } from "../shared/transcript-history-loader.js";

// The bug this pins: the Orchestrator pane rebuilds its history loader when the
// scroller element changes (welcome -> transcript, attention card -> transcript,
// screen remount), and the teardown called `.dispose?.()`. The helper returns
// `{ detach, sync }` -- there is no `dispose` -- and the optional call made that
// a silent no-op. So every swap left the old IntersectionObserver alive on a
// detached node while a second one attached: a leak, and two loaders answering
// the same sentinel.
test("the loader exposes detach, not dispose", () => {
  const observed = [];
  const disconnected = [];
  class ObserverSpy {
    constructor(callback) {
      this.callback = callback;
    }
    observe(node) {
      observed.push(node);
    }
    disconnect() {
      disconnected.push(this);
    }
  }
  const sentinel = { nodeType: 1 };
  const scrollElement = { querySelector: () => sentinel };

  const loader = attachTranscriptHistoryLoader({
    onLoad: async () => false,
    scrollElement,
    ObserverCtor: ObserverSpy,
  });
  loader.sync();

  assert.equal(typeof loader.detach, "function", "this is the teardown callers must use");
  assert.equal(loader.dispose, undefined, "`dispose?.()` silently did nothing");
  assert.equal(observed.length, 1, "the sentinel is being watched");

  loader.detach();
  assert.equal(disconnected.length, 1, "and detaching actually stops watching it");
});
