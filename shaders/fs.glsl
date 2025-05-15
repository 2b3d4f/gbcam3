#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D uTexture;
uniform float uBrightness; // -1 .. 1
uniform float uContrast;   // 0 .. 3
uniform bool  uUseDither;
uniform vec3  uPalette[4];
// crop parameters (scale & offset)
uniform vec2  uTexScale;  // how much of the video to keep (1 = full)
uniform vec2  uTexOffset; // top-left offset after scale, 0-1
out vec4 outColor;

const vec3 LUMA = vec3(0.299,0.587,0.114);
const float BAYER4[16] = float[16](
    0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
    3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
);

void main(){
    // map screen UV to cropped video UV
    vec2 uv = vTexCoord * uTexScale + uTexOffset;

    // original luminance 0-1
    float y = dot(texture(uTexture, uv).rgb, LUMA);
    // apply brightness / contrast and clamp
    y = clamp((y - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
    // quantise to four levels (0-3)
    float level;
    if(uUseDither){
    ivec2 ij = ivec2(mod(gl_FragCoord.xy, 4.0));
    float threshold = (BAYER4[ij.y * 4 + ij.x] + 0.5) / 16.0;
    level = clamp(floor(y * 4.0 + threshold), 0.0, 3.0);
    }else{
    level = floor(y * 4.0);
    }
    int idx = int(level);
    vec3 col = uPalette[idx];
    outColor = vec4(col, 1.0);
}
