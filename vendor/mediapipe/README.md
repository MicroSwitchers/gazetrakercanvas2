# MediaPipe (vendored)

Used by `js/webcam-gaze.js` for webcam eye tracking. Kept here so webcam tracking works offline and no video or images leave the computer.

- `vision_bundle.mjs`, `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm`: `@mediapipe/tasks-vision` 1.0.1, from npm (https://www.npmjs.com/package/@mediapipe/tasks-vision).
- `face_landmarker.task`: the Face Landmarker model (float16, version 1), from https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task. It finds 478 face points, including 5 per iris, plus the head's pose.

Both are by Google and licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). They are unchanged.
