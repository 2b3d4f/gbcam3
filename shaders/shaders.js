export const vsSource = fetch('../shaders/vs.glsl').then(r => r.text());
export const fsSource = fetch('../shaders/fs.glsl').then(r => r.text());
