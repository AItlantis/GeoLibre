var l={name:"create-texture-unorm",inject:{"fs:#decl":"uniform sampler2D textureName;","fs:DECKGL_FILTER_COLOR":`
      color = texture(textureName, geometry.uv);
    `},getUniforms:e=>({textureName:e.textureName})},t={name:"black-is-zero",inject:{"fs:#decl":`
  vec3 black_zero_to_rgb(float value) {
    return vec3(value, value, value);
  }
`,"fs:DECKGL_FILTER_COLOR":`
      color.rgb = black_zero_to_rgb(color.r);
    `}},a="colormap",s={name:a,fs:`uniform ${a}Uniforms {
  int colormapIndex;
  float reversed;
} ${a};
`,inject:{"fs:#decl":`precision highp sampler2DArray;
uniform sampler2DArray colormapTexture;
`,"fs:DECKGL_FILTER_COLOR":`
      float idx = mix(color.r, 1.0 - color.r, ${a}.reversed);
      color = texture(
        colormapTexture,
        vec3(idx, 0.5, float(${a}.colormapIndex))
      );
    `},uniformTypes:{colormapIndex:"i32",reversed:"f32"},getUniforms:e=>({colormapTexture:e.colormapTexture,colormapIndex:e.colormapIndex??0,reversed:e.reversed??!1})},o="nodata",c={name:o,fs:`uniform ${o}Uniforms {
  float value;
} ${o};
`,inject:{"fs:DECKGL_FILTER_COLOR":`
    if (color.r == nodata.value) {
      discard;
    }
    `},uniformTypes:{value:"f32"},getUniforms:e=>({value:e.value})},r="linearRescale",m={name:r,fs:`uniform ${r}Uniforms {
  float rescaleMin;
  float rescaleMax;
} ${r};
`,inject:{"fs:DECKGL_FILTER_COLOR":`
  color.rgb = clamp((color.rgb - ${r}.rescaleMin) / (${r}.rescaleMax - ${r}.rescaleMin), 0.0, 1.0);
`},uniformTypes:{rescaleMin:"f32",rescaleMax:"f32"},getUniforms:e=>({rescaleMin:e.rescaleMin??0,rescaleMax:e.rescaleMax??1})},n={name:"mask-texture",inject:{"fs:#decl":"uniform sampler2D maskTexture;","fs:DECKGL_FILTER_COLOR":`
      float maskValue = texture(maskTexture, geometry.uv).r;
      if (maskValue == 0.0) {
        discard;
      }
    `},getUniforms:e=>({maskTexture:e.maskTexture})};export{t as a,s as i,m as n,l as o,c as r,n as t};
