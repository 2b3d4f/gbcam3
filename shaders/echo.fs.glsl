#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D uCurrent;
uniform sampler2D uPrevious;
uniform float uDecay;
out vec4 outColor;

void main() {
  vec3 curr = texture(uCurrent, vTexCoord).rgb;
  vec3 prev = texture(uPrevious, vTexCoord).rgb;
  // Blend current frame with previous frame for echo, preventing brightness buildup
  vec3 col = mix(curr, prev, uDecay);
  outColor = vec4(col, 1.0);
}