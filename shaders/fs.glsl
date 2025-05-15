#version 300 es
precision highp float;
in vec2 vTexCoord;
uniform sampler2D uTexture;
uniform float uBrightness; // -1 .. 1
uniform float uContrast;   // 0 .. 3
uniform bool  uUseDither;
uniform vec3  uPalette[4];
uniform vec2  uTexScale;
uniform vec2  uTexOffset;
out vec4 outColor;

// Luminance conversion
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
// Bayer dithering matrix (4x4)
const float BAYER4[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
);

// Apply brightness and contrast
float applyBC(float y) {
    return clamp((y - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
}

// Compute quantized level with optional dithering
float quantizeLevel(float y) {
    if (uUseDither) {
        ivec2 ij = ivec2(mod(gl_FragCoord.xy, 4.0));
        float threshold = (BAYER4[ij.y * 4 + ij.x] + 0.5) / 16.0;
        return clamp(floor(y * 4.0 + threshold), 0.0, 3.0);
    }
    return floor(y * 4.0);
}

// Lookup palette color
vec3 lookupColor(float level) {
    return uPalette[int(level)];
}

void main() {
    // map screen UV to cropped video UV
    vec2 uv = vTexCoord * uTexScale + uTexOffset;
    // compute luminance
    float y = dot(texture(uTexture, uv).rgb, LUMA);
    // apply brightness/contrast
    y = applyBC(y);
    // quantize to 4 levels
    float level = quantizeLevel(y);
    // map to palette color
    vec3 col = lookupColor(level);
    outColor = vec4(col, 1.0);
}
