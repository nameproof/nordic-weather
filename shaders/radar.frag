#version 440
// yr.no radar frames are opaque RGB: black means "no precipitation" and
// white means "outside radar coverage"; precipitation is always a saturated
// colour (blues, purples). Every palette colour has a max channel of ~1, so
// where a colour fades into black after texture filtering the max channel
// is the coverage: use it as alpha and treat the colour as premultiplied
// (no dark fringes). Outside coverage the map gets faint diagonal lines
// (fixed to screen pixels, so they stay crisp at any zoom) over a slight
// darkening. Coverage comes from one image for the whole loop, its latest
// observation: yr.no's frames disagree on it (a radar missing from one
// observation, forecast frames filling the gaps as they run ahead), which
// would make it change shape through the loop.
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
};
layout(binding = 1) uniform sampler2D source;
layout(binding = 2) uniform sampler2D coverageMap;

void main() {
    vec4 c = texture(source, qt_TexCoord0);
    float m = max(c.r, max(c.g, c.b));
    float s = m - min(c.r, min(c.g, c.b));
    vec4 rain = vec4(c.rgb, m) * smoothstep(0.03, 0.08, m) * smoothstep(0.08, 0.2, s) * strength;

    vec4 cov = texture(coverageMap, qt_TexCoord0);
    float cm = max(cov.r, max(cov.g, cov.b));
    float cs = cm - min(cov.r, min(cov.g, cov.b));
    float outside = smoothstep(0.5, 0.95, cm) * (1.0 - smoothstep(0.05, 0.15, cs));
    // 45° lines lineSpacing px apart and lineWidth px wide (may be under a
    // pixel): approximate pixel coverage, so thin lines fade rather than alias.
    float u = (gl_FragCoord.x + gl_FragCoord.y) * 0.70710678;
    float d = abs(mod(u, lineSpacing) - lineSpacing * 0.5);
    float cover = clamp(lineWidth * 0.5 + 0.5 - d, 0.0, 1.0) * min(1.0, lineWidth);
    float lineA = cover * lineStrength * outside;
    vec4 lines = vec4(lineColor.rgb * lineA, lineA);
    vec4 dim = vec4(0.0, 0.0, 0.0, dimStrength * outside);
    vec4 noData = lines + dim * (1.0 - lines.a);

    fragColor = (rain + noData * (1.0 - rain.a)) * qt_Opacity;
}
