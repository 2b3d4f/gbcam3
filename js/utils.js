// utils.js
// Shader and preset loading utilities
export const vsSource = fetch('./shaders/vs.glsl').then(r => r.text());
export const fsSource = fetch('./shaders/fs.glsl').then(r => r.text());
export const echoFsSource = fetch('./shaders/echo.fs.glsl').then(r => r.text());
export const passFsSource = fetch('./shaders/pass.fs.glsl').then(r => r.text());

/**
 * Load shader sources: vs, fs, echo, pass
 * @returns {Promise<{vsText:string,fsText:string,echoFsText:string,passFsText:string}>}
 */
export async function loadShaders() {
  const [vsText, fsText, echoFsText, passFsText] = await Promise.all([
    vsSource,
    fsSource,
    echoFsSource,
    passFsSource
  ]);
  return { vsText, fsText, echoFsText, passFsText };
}

/**
 * Load presets JSON from /presets.json
 * @returns {Promise<any>}
 */
export async function loadPresets() {
  const data = await fetch('./presets.json').then(r => r.json());
  return data;
}