import test from "node:test";
import assert from "node:assert/strict";
import { heightSliderProps } from "./useViewModeToggle";

test("heightSliderProps is disabled while flat", () => {
  const props = heightSliderProps(false, 20, 0, 120);
  assert.equal(props.disabled, true);
  assert.equal(props.value, 20);
  assert.deepEqual([props.min, props.max], [0, 120]);
});

test("heightSliderProps is enabled while extruded", () => {
  const props = heightSliderProps(true, 20, 0, 120);
  assert.equal(props.disabled, false);
});
