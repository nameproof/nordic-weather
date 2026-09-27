#version 440
// The assembled radar frame on screen, drawn part of the way to the next
// frame (the smoothing test): blend 0 is the frame itself, 1 the next one.
// Crossfade mixes the two frames' rain. Flow also moves each frame's rain
// along the motion between them (Flow.mjs), so it slides instead of
// fading. Rain and no-coverage are drawn as in radar.frag; coverage never
// moves, so the no-coverage lines come from the current frame alone.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    float strength;
    float dimStrength;
    float lineStrength;
    float lineSpacing;
    float lineWidth;
    vec4 lineColor;
    float blend;
    float flowOn;
    float flowPair;
    float flowPairs;
    float flowUnit;
    vec2 flowGrid;
    vec2 flowCell;
    vec2 mapSize;
};
layout(binding = 1) uniform sampler2D sourceA;
layout(binding = 2) uniform sampler2D sourceB;
layout(binding = 3) uniform sampler2D flowField;

// See radar.frag: premultiplied rain from an opaque palette colour.
vec4 rainOf(vec4 c) {
    float m = max(c.r, max(c.g, c.b));
    float s = m - min(c.r, min(c.g, c.b));
    return vec4(c.rgb, m) * smoothstep(0.03, 0.08, m) * smoothstep(0.08, 0.2, s);
}

// Motion from this frame to the next at uv, in uv units. The atlas stacks
// flowPairs fields of flowGrid cells top to bottom; y stays between cell
// centres so filtering never reads the neighbouring pair's field.
vec2 flowAt(vec2 uv) {
    vec2 g = clamp(uv * mapSize / flowCell, vec2(0.5), flowGrid - vec2(0.5));
    vec2 t = vec2(g.x / flowGrid.x, (flowPair * flowGrid.y + g.y) / (flowGrid.y * flowPairs));
    vec2 px = (texture(flowField, t).rg * 255.0 - 128.0) / flowUnit;
    return px / mapSize;
}

void main() {
    vec4 a = texture(sourceA, qt_TexCoord0);
    vec4 rain;
    if (blend <= 0.0) {
        rain = rainOf(a);
    } else {
        // Rain at p now was at p − blend·v in this frame and will be at
        // p + (1 − blend)·v in the next.
        vec2 v = flowOn > 0.5 ? flowAt(qt_TexCoord0) : vec2(0.0);
        vec4 ra = rainOf(flowOn > 0.5 ? texture(sourceA, qt_TexCoord0 - blend * v) : a);
        vec4 rb = rainOf(texture(sourceB, qt_TexCoord0 + (1.0 - blend) * v));
        rain = mix(ra, rb, blend);
    }
    rain *= strength;

    float m = max(a.r, max(a.g, a.b));
    float s = m - min(a.r, min(a.g, a.b));
    float outside = smoothstep(0.5, 0.95, m) * (1.0 - smoothstep(0.05, 0.15, s));
    float u = (gl_FragCoord.x + gl_FragCoord.y) * 0.70710678;
    float d = abs(mod(u, lineSpacing) - lineSpacing * 0.5);
    float cover = clamp(lineWidth * 0.5 + 0.5 - d, 0.0, 1.0) * min(1.0, lineWidth);
    float lineA = cover * lineStrength * outside;
    vec4 lines = vec4(lineColor.rgb * lineA, lineA);
    vec4 dim = vec4(0.0, 0.0, 0.0, dimStrength * outside);
    vec4 noData = lines + dim * (1.0 - lines.a);

    fragColor = (rain + noData * (1.0 - rain.a)) * qt_Opacity;
}
