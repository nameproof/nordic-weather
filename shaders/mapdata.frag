#version 440
// Colours the base map tiles built by scripts/build-basemap.py. They hold
// masks, not colours: R = water, G = road (brighter = bigger road),
// B = national border. Areas without a tile are transparent.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec4 landColor;
    vec4 waterColor;
    vec4 roadColor;
    vec4 borderColor;
};
layout(binding = 1) uniform sampler2D source;

void main() {
    vec4 c = texture(source, qt_TexCoord0);
    vec3 m = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    vec3 col = mix(landColor.rgb, waterColor.rgb, m.r);
    col = mix(col, roadColor.rgb, m.g);
    col = mix(col, borderColor.rgb, m.b);
    fragColor = vec4(col, 1.0) * c.a * qt_Opacity;
}
