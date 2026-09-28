#version 440
// The assembled radar frame on screen, drawn part of the way to the next
// frame (the smoothing test): blend 0 is the frame itself, 1 the next one.
// Fade mixes the two frames' rain. Flow moves rain along the motion between
// them (Flow.mjs), so it slides instead of fading. Rain and no-coverage are
// drawn as in radar.frag. No-coverage comes from one image for the whole
// loop, the latest observation: yr.no's frames disagree on it (a radar
// missing from one observation, forecasts filling the gaps as they run),
// which would make it flicker through the loop.
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
layout(binding = 4) uniform sampler2D coverageMap;

// See radar.frag: premultiplied rain from an opaque palette colour.
vec4 rainOf(vec4 c) {
    float m = max(c.r, max(c.g, c.b));
    float s = m - min(c.r, min(c.g, c.b));
    return vec4(c.rgb, m) * smoothstep(0.03, 0.08, m) * smoothstep(0.08, 0.2, s);
}

// Motion from this frame to the next at uv, in uv units. The atlas stacks
// flowPairs fields of flowGrid cells top to bottom; y stays between cell
// centres so filtering never reads the neighbouring pair's field.
vec3 flowAt(vec2 uv) {
    vec2 g = clamp(uv * mapSize / flowCell, vec2(0.5), flowGrid - vec2(0.5));
    vec2 t = vec2(g.x / flowGrid.x, (flowPair * flowGrid.y + g.y) / (flowGrid.y * flowPairs));
    vec3 field = texture(flowField, t).rgb;
    vec2 px = (field.rg * 255.0 - 128.0) / flowUnit;
    return vec3(px / mapSize, smoothstep(0.15, 0.65, field.b));
}

// Four filtered taps a third of a pixel apart: a small softening that is
// the same however far a frame is moved. Plain filtering softens a frame
// moved by half a pixel more than one on whole pixels (a pulse, 16% in
// texture contrast); unfiltered, rain moves in uneven whole-pixel strides
// (a stagger).
vec4 soft(sampler2D image, vec2 uv) {
    vec2 d = 0.35 / mapSize;
    return 0.25 * (texture(image, uv + vec2(-d.x, -d.y)) + texture(image, uv + vec2(d.x, -d.y))
                 + texture(image, uv + vec2(-d.x, d.y)) + texture(image, uv + vec2(d.x, d.y)));
}

void main() {
    vec4 a = texture(sourceA, qt_TexCoord0);
    vec4 rain;
    if (flowOn > 0.5) {
        // One real frame, moved along the motion: this one pushed forward
        // for the first half of the interval, the next one pulled back for
        // the second. Never an average of the two, which would wash the
        // rain's texture out between frames (a 4 Hz pulse); colours stay
        // those of a radar image, changing once per frame as with smoothing
        // off. Motion counts as far as it is trusted, so where it isn't,
        // rain just switches frame halfway.
        vec2 uv = qt_TexCoord0;
        bool next = blend >= 0.5;
        if (blend > 0.0) {
            vec3 field = flowAt(qt_TexCoord0);
            vec2 v = field.xy * field.z;
            uv = next ? uv + (1.0 - blend) * v : uv - blend * v;
            // Outside the map crop there is nothing to move in.
            if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) uv = qt_TexCoord0;
        }
        rain = rainOf(next ? soft(sourceB, uv) : soft(sourceA, uv));
    } else if (blend <= 0.0) {
        rain = rainOf(a);
    } else {
        rain = mix(rainOf(a), rainOf(texture(sourceB, qt_TexCoord0)), blend);
    }
    rain *= strength;

    vec4 cov = texture(coverageMap, qt_TexCoord0);
    float m = max(cov.r, max(cov.g, cov.b));
    float s = m - min(cov.r, min(cov.g, cov.b));
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
