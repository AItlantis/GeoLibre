import{Hs as y,Us as D,_s as T,bc as V,gc as G,gs as N,hs as X,ms as j,xc as p}from"./maplibre-Ezo9vfdW.js";function m(t,e,r=!1){if(r)return e===1?"float":`vec${e}`;switch(t){case"uint8":case"uint16":case"uint32":return e===1?"uint":`uvec${e}`;case"sint8":case"sint16":case"sint32":return e===1?"int":`ivec${e}`;default:return e===1?"float":`vec${e}`}}function z(t,e,r=!1){let n;if(r)switch(t){case"uint8":n="unorm8";break;case"sint8":n="snorm8";break;case"uint16":n="unorm16";break;case"sint16":n="snorm16";break;case"float32":n="float32";break;default:throw new Error(`Unsupported normalized vertex format for ${t}`)}else n=t;return e===1?n:e===3&&!n.startsWith("float32")&&!n.endsWith("32")?`${n}x3-webgl`:`${n}x${e}`}function $(t){switch(t[0]){case"u":return"0u";case"s":return"0";default:return"0."}}function H(t,e){switch(t){case"uint8":case"uint16":case"uint32":return`${Math.trunc(e)}u`;case"sint8":case"sint16":case"sint32":return`${Math.trunc(e)}`;default:return Number.isInteger(e)?`${e}.0`:`${e}`}}function q(t){switch(t){case"uint8":return"r8uint";case"sint8":return"r8sint";case"uint16":return"r16uint";case"sint16":return"r16sint";case"uint32":return"r32uint";case"sint32":return"r32sint";case"float32":return"r32float";default:throw new Error(`Unsupported WebGL gather texture format for ${t}`)}}function Le(t){return t}function W(t){switch(t){case"uint32":return"usampler2D";case"sint32":return"isampler2D";case"float32":return"sampler2D";default:throw new Error(`Unsupported WebGL gather sampler type for ${t}`)}}var Z="GPGPU Operation Counts",J="Transform Runs",K=new V;function _({module:t,elementWise:e=!1,expression:r,inputs:n,output:i,operationType:u=i.type,outputBuffer:o}){const s=o.device,a=b("result",i.type,i.size,i.normalized),f=[t,a],l=[],d={},g=m(i.type,1,i.normalized),x=m(u,1,i.normalized);let L="",v=null;const P={TYPE:x,RESULT_LEN:i.size.toString()},w=Q(n);for(const[c,h]of w)f.push(I(c,h.type,h.size,h.normalized,u)),l.push(A(c,h)),h instanceof N?d[c]=h.buffer:(v=v||T.createOrReuse(s,o.byteLength),d[c]=v),L+=`TYPE ${c}[${h.size}]; get_${c}(${c});
`,P[`${c.toUpperCase()}_LEN`]=h.size.toString();let E="";if(r)for(let c=0;c<i.size;c++)E+=`result[${c}]=${r(c)};
`;else if(e)for(let c=0;c<i.size;c++){const h=$(x),O=w.map(([U,k])=>c<k.size?`${U}[${c}]`:h);E+=`result[${c}]=${t.name}(${O.join(", ")});
`}else E=`${t.name}(${w.map(([c])=>c).join(", ")}, result);`;const M=`#version 300 es

void main() {
${L}
${g} result[${i.size}];
${E}
set_result(result);
}
  `,B=new y(s,{vs:M,shaderAssembler:K,defines:P,modules:f,bufferLayout:l,vertexCount:1,instanceCount:i.length,attributes:d,feedbackBufferMode:"interleaved",outputs:a.varyings});s.statsManager.getStats(Z).get(J).incrementCount(),B.run({inputBuffers:d,outputBuffers:{[a.varyings[0]]:i.offset===0?o:{buffer:o,byteOffset:i.offset,byteLength:i.byteLength}}}),v&&T.recycle(v)}function Q(t){return Array.isArray(t)?t.map((e,r)=>[`x${r}`,e]):Object.entries(t)}function I(t,e,r,n=!1,i=e){let u="",o="";for(let s=0;s<r;s+=4){const a=Math.min(r-s,4),f=m(e,a,n);u+=`in ${f} a${t}_${s};
`;for(let l=0;l<a;l++){let d=`a${t}_${s}`;a>1&&(d=`${d}[${l}]`),(n||e!==i)&&(d=`TYPE(${d})`),o+=`v[${s+l}]=${d};
`}}return{name:t,vs:`
${u}
void get_${t}(out TYPE v[${r}]) {
  ${o}
}
`}}function A(t,e){const r={name:t,stepMode:e.isConstant?"vertex":"instance",byteStride:e.stride,attributes:[]};for(let n=0;n<e.size;n+=4){const i=Math.min(e.size-n,4);r.attributes.push({attribute:`a${t}_${n}`,format:z(e.type,i,e.normalized),byteOffset:e.offset+e.ValueType.BYTES_PER_ELEMENT*n})}return r}function b(t,e,r,n=!1){const i=[],u=m(e,1,n);let o="",s="";for(let a=0;a<r;a+=4){const f=Math.min(r-a,4),l=m(e,f,n);i.push(`${t}_${a}`),o+=`flat out ${l} ${t}_${a};
`;const d=Array.from({length:f},(g,x)=>a+x);s+=`${t}_${a} = ${l}(${d.map(g=>`v[${g}]`).join(",")});
`}return{name:t,varyings:i,vs:`
${o}
void set_${t}(in ${u} v[${r}]) {
  ${s}
}
`}}var ee=`TYPE arithmetic_add(TYPE x, TYPE y) {
  return x + y;
}

TYPE arithmetic_subtract(TYPE x, TYPE y) {
  return x - y;
}

TYPE arithmetic_multiply(TYPE x, TYPE y) {
  return x * y;
}

TYPE arithmetic_divide(TYPE x, TYPE y) {
  return x / y;
}

float arithmetic_tan(float x) {
  return tan_fp32(x);
}
`,F=({inputs:t,output:e,target:r})=>{const n=e.type,i=m(n,1,e.normalized),u=$(i),o=t.namedInputs;return _({module:{name:"arithmetic",dependencies:[G],vs:ee},inputs:o,output:e,operationType:n,outputBuffer:r,expression:s=>j(t.expression,{operations:X,inputs:o,laneIndex:s,formatInput:a=>`${a}[${s}]`,formatOutOfBoundsInput:a=>o[a].size===1?`${a}[0]`:u,formatLiteral:a=>{const f=Array.isArray(a)?a[s]??0:a;return`${i}(${H(n,f)})`},formatCall:(a,f)=>`${a}(${f.join(", ")})`})}),{success:!0}},te="GPGPU Operation Counts",ne="Transform Runs",re=({inputs:t,output:e,target:r})=>{const{sourceValues:n}=t,i=r.device;if(n.length===0){const f=new e.ValueType(e.length*e.size);return r.write(f),{success:!0,value:f}}if(n.isConstant){const f=n.value,l=new e.ValueType(e.length*e.size);for(let d=0;d<e.length;d++){const g=f[d];l[d*2]=g,l[d*2+1]=g}return r.write(l),{success:!0,value:l}}const u=i.createTexture({width:1,height:e.length,format:"rg32float",usage:p.RENDER|p.COPY_SRC|p.COPY_DST}),o=i.createFramebuffer({colorAttachments:[u]}),s=new D(i,{vs:`#version 300 es

flat out float extent_value;

void main() {
  float sourceValues[SOURCE_VALUES_LEN];
  get_sourceValues(sourceValues);
  extent_value = sourceValues[gl_VertexID];

  float y = (float(gl_VertexID) + 0.5) / float(CHANNEL_COUNT) * 2.0 - 1.0;
  gl_Position = vec4(0.0, y, 0.0, 1.0);
  gl_PointSize = 1.0;
}
  `,fs:`#version 300 es

precision highp float;

flat in float extent_value;
out vec2 fragColor;

void main() {
  fragColor = vec2(-extent_value, extent_value);
}
  `,topology:"point-list",parameters:{depthCompare:"always",blend:!0,blendColorSrcFactor:"one",blendColorDstFactor:"one",blendColorOperation:"max",blendAlphaSrcFactor:"one",blendAlphaDstFactor:"one",blendAlphaOperation:"max"},modules:[I("sourceValues",n.type,n.size,n.normalized)],defines:{TYPE:"float",SOURCE_VALUES_LEN:n.size.toString(),CHANNEL_COUNT:e.length.toString()},attributes:{sourceValues:n.buffer},bufferLayout:[A("sourceValues",n)],instanceCount:n.length,vertexCount:e.length,disableWarnings:!0}),a=T.createOrReuse(i,e.byteLength);try{const f=i.beginRenderPass({framebuffer:o,parameters:{viewport:[0,0,1,e.length]},clearColor:[-R,-R,0,0],clearDepth:!1,clearStencil:!1});i.statsManager.getStats(te).get(ne).incrementCount(),s.draw(f),f.end();const l=i.createCommandEncoder();return l.copyTextureToBuffer({sourceTexture:u,width:1,height:e.length,destinationBuffer:a,byteOffset:0,bytesPerRow:8}),i.submit(l.finish()),F({device:i,inputs:{expression:{kind:"call",op:"multiply",args:[{kind:"input",name:"x"},{kind:"literal",value:[-1,1]}]},namedInputs:{x:new N({buffer:a,size:2,type:"float32",length:e.length})}},output:e,target:r})}finally{s.destroy(),T.recycle(a),o.destroy(),u.destroy()}},R=3e38,ie=({inputs:t,output:e,target:r})=>{const n=t.map((o,s)=>[`x${s}`,o]);se(r.device.limits.maxVertexAttributes,n),ae(r.device.limits.maxInterStageShaderVariables,e);const i=n.map(([o,s])=>`in TYPE ${o}[${s.size}]`).join(", ");let u=0;return _({module:{name:"interleave",vs:`void interleave(${i}, out TYPE result[RESULT_LEN]) {
${n.map(([o,s])=>{const a=Array.from({length:s.size},(f,l)=>`  result[${u+l}] = ${o}[${l}];`).join(`
`);return u+=s.size,a}).join(`
`)}
}
`},inputs:t,output:e,outputBuffer:r}),{success:!0}};function se(t,e){const r=e.reduce((n,[,i])=>n+Math.ceil(i.size/4),0);if(r>t)throw new Error(`interleave() requires ${r} vertex attributes, exceeding device limit ${t}`)}function ae(t,e){if(e.size>t)throw new Error(`interleave() output size ${e.size} exceeds device inter-stage component limit ${t}`)}function oe(){const t=new Uint16Array([255]);return new Uint8Array(t.buffer)[0]>0}var ue=`#define LE ${oe()?1:0}
const uint F32_NAN = 0xffffffffu;
const uint F32_INF = 0x7f800000u;

// Find first set bit using binary search
// https://en.wikipedia.org/wiki/Find_first_set#CLZ
int countLeadingZeros(uint a) {
  if (a == 0u) return 32;
  int n = 0;
  if ((a & 0xffff0000u) == 0u) { n += 16; a = a << 16; }
  if ((a & 0xff000000u) == 0u) { n += 8;  a = a << 8;  }
  if ((a & 0xf0000000u) == 0u) { n += 4;  a = a << 4;  }
  if ((a & 0xc0000000u) == 0u) { n += 2;  a = a << 2;  }
  if ((a & 0x80000000u) == 0u) return n + 1;
  return n;
}

uint roundShiftRight(uint value, int shift) {
  if (shift <= 0) {
    return value << (-shift);
  }

  if (shift >= 32) {
    if (shift == 32 && value > 0x80000000u) {
      return 1u;
    }
    return 0u;
  }

  uint truncated = value >> shift;
  uint halfShift = 1u << (shift - 1);
  uint remainder = value & ((1u << shift) - 1u);
  if (remainder > halfShift || (remainder == halfShift && (truncated & 1u) == 1u)) {
    return truncated + 1u;
  }
  return truncated;
}

uint makeFloat_(uint sign, int exponent, uint mantissa) {
  return (sign << 31) | (uint(exponent + 127) << 23) | (mantissa & 0x7fffffu);
}

/**
 * Assemble a float32 in bit representation according to IEEE 754
 * https://en.wikipedia.org/wiki/Single-precision_floating-point_format
 */
uint makeFloat(uint sign, int exponent, uint significand) {
  if (significand == 0u) {
    return sign << 31;
  }

  // Remove any extra leading zeros for better precision
  int lead_zeros = countLeadingZeros(significand);
  // Significand is encoded as 1.fraction
  int normalizedExponent = exponent + 31 - lead_zeros;

  if (normalizedExponent > 127) {
    return (sign << 31) | F32_INF;
  }

  uint mantissa;
  if (normalizedExponent >= -126) {
    mantissa = roundShiftRight(significand, 8 - lead_zeros);
    if (mantissa >= 0x1000000u) {
      mantissa >>= 1;
      normalizedExponent++;
      if (normalizedExponent > 127) {
        return (sign << 31) | F32_INF;
      }
    }
    return makeFloat_(sign, normalizedExponent, mantissa);
  }

  int subnormalShift = -149 - exponent;
  mantissa = roundShiftRight(significand, subnormalShift);
  if (mantissa >= 0x800000u) {
    return (sign << 31) | (1u << 23);
  }
  return (sign << 31) | mantissa;
}

/**
 * Parse 8-byte memory as a float64 number according to IEEE 754
 * https://en.wikipedia.org/wiki/Double-precision_floating-point_format
 * Returns 8-byte memory as 2 float32 numbers, consisting of
 * high part: fround(d)
 * low part: d - fround(d)
 */
uvec2 parseAsDouble(uvec2 d) {
  #if LE
  d = d.yx; // to big endian
  #endif

  uint sign = (d[0] >> 31) & 1u; // first bit
  uint exponentBits = (d[0] >> 20) & 0x7ffu;
  int exponent = int(exponentBits) - 1023; // next 11 bits
  uint fractionHigh = d[0] & 0xfffffu;
  uint fractionLow = d[1];

  if (exponentBits == 0x7ffu) {
    if (fractionHigh == 0u && fractionLow == 0u) {
      return uvec2((sign << 31) | F32_INF, F32_NAN);
    }
    return uvec2(F32_NAN);
  }
  
  if (exponentBits == 0u) {
    // All float64 subnormals are too small to survive a float32 split.
    return uvec2(sign << 31);
  }

  if (exponent > 127) {
    return uvec2((sign << 31) | F32_INF, ((1u - sign) << 31) | F32_INF);
  }

  uint hi_part;
  uint low_part;

  // float64 significand has 52 bits
  // float32 significand has 23 bits
  // The significand of the high part is the significand of the double, trimmed
  uint f_hi = 0x800000u | (fractionHigh << 3) | (fractionLow >> 29);
  uint f_low = fractionLow & 0x1fffffffu;

  if (exponent < -126) {
    // For tiny normals, the top 24 significand bits still contribute to the float32
    // high part, but they land in the float32 subnormal range.
    hi_part = makeFloat(sign, exponent - 23, f_hi);

    // The residual keeps the remaining 29 significand bits at the original double scale.
    low_part = makeFloat(sign, exponent - 52, f_low);
    return uvec2(hi_part, low_part);
  }

  bool roundUp = f_low > 0x10000000u || (f_low == 0x10000000u && (f_hi & 1u) == 1u);

  uint f_rounded = f_hi + (roundUp ? 1u : 0u);
  int exponent_hi = exponent;
  if (f_rounded == 0x1000000u) {
    f_rounded = 0x800000u;
    exponent_hi++;
  }

  if (exponent_hi > 127) {
    // Overflows float32 limit
    hi_part = (sign << 31) | F32_INF;
    low_part = ((1u - sign) << 31) | F32_INF;
    return uvec2(hi_part, low_part);
  }
  
  hi_part = makeFloat_(sign, exponent_hi, f_rounded);

  int remainder = int(f_low);
  uint sign_low = sign;
  if (roundUp) {
    remainder -= 0x20000000;
  }
  if (remainder < 0) {
    sign_low = 1u - sign;
    remainder = -remainder;
  }
  low_part = makeFloat(sign_low, exponent - 52, uint(remainder));

  return uvec2(hi_part, low_part);
}

void fround(in uint x[X_LEN], out float result[X_LEN]) {
  int n = X_LEN / 2;
  for (int i = 0; i < n; i++) {
    uvec2 f = parseAsDouble(uvec2(x[i * 2], x[i * 2 + 1]));
    result[i] = uintBitsToFloat(f.x);
    result[i + n] = uintBitsToFloat(f.y);
  }
}
`,le=({inputs:t,output:e,target:r})=>(_({module:{name:"fround",vs:ue},inputs:t,output:e,operationType:"uint32",outputBuffer:r}),{success:!0});function C(t,e,r){const n=W(r),i=m(e,1),u=Array.from({length:t.size},(o,s)=>`  v[${s}] = ${i}(texelFetch(source_values_texture, ivec2(${s}, rowIndex), 0).r);`).join(`
`);return{name:"source_values_texture",vs:`
uniform highp ${n} source_values_texture;
void read_source_values(int rowIndex, out TYPE v[${t.size}]) {
${u}
}
`}}function Y(t,e,r){const n=r.createTexture({width:Math.max(t.size,1),height:t.length,format:q(e),usage:p.SAMPLE|p.COPY_DST});if(t.length===0)return n;const i=r.createCommandEncoder();return i.copyBufferToTexture({sourceBuffer:t.buffer,destinationTexture:n,byteOffset:t.offset,bytesPerRow:t.stride,rowsPerImage:t.length,size:[t.size,t.length,1]}),r.submit(i.finish()),n}var fe=async({inputs:t,output:e,target:r})=>{const{ids:n,sourceValues:i}=t,u=r.device,o=b("result",e.type,e.size),s=m(n.type,1),a=m(e.type,1),f=e.type,l=Y(i,f,u),d=`#version 300 es

void main() {
  INDEX_TYPE ids[1];
  get_ids(ids);
  TYPE result[${e.size}];
  gather(ids, result);
  set_result(result);
}
  `,g=new y(u,{vs:d,defines:{INDEX_TYPE:s,TYPE:a,RESULT_LEN:e.size.toString(),SOURCE_VALUES_ROWS:i.length.toString()},modules:[ce(n,s),C(i,e.type,f),me(e.type),o],bindings:{source_values_texture:l},bufferLayout:[de(n)],vertexCount:1,instanceCount:e.length,feedbackBufferMode:"interleaved",outputs:o.varyings});try{return g.run({inputBuffers:{ids:n.buffer},outputBuffers:{[o.varyings[0]]:r}}),{success:!0}}finally{g.destroy(),l.destroy()}};function ce(t,e){const r=m(t.type,1);let n="aids_0";return t.type!==ge(e)&&(n=`${e}(${n})`),{name:"ids",vs:`
in ${r} aids_0;
void get_ids(out INDEX_TYPE v[1]) {
  v[0] = ${n};
}
`}}function de(t){return{name:"ids",stepMode:t.isConstant?"vertex":"instance",byteStride:t.stride,attributes:[{attribute:"aids_0",format:z(t.type,1,t.normalized),byteOffset:t.offset}]}}function me(t){return{name:"gather",vs:`
void zero_result(out TYPE result[RESULT_LEN]) {
  for (int i = 0; i < RESULT_LEN; i++) {
    result[i] = ${$(t)};
  }
}

void gather(in INDEX_TYPE ids[1], out TYPE result[RESULT_LEN]) {
  int sourceIndex = int(ids[0]);
  if (sourceIndex < 0 || sourceIndex >= SOURCE_VALUES_ROWS) {
    zero_result(result);
    return;
  }
  read_source_values(sourceIndex, result);
}
`}}function ge(t){switch(t){case"uint":return"uint32";case"int":return"sint32";default:return"float32"}}var he=`void row_dot(in TYPE x[X_LEN], in TYPE y[Y_LEN], out float result[1]) {
  float sum = 0.0;
  for (int i = 0; i < X_LEN; i++) {
    sum += float(x[i]) * float(y[i]);
  }
  result[0] = sum;
}
`,_e=({inputs:t,output:e,target:r})=>(_({module:{name:"row_dot",vs:he},inputs:t,output:e,operationType:"float32",outputBuffer:r}),{success:!0}),ve=`void equalAll(in TYPE x[X_LEN], in TYPE y[Y_LEN], out uint result[1]) {
  uint allEqual = uint(1);
  for (int i = 0; i < X_LEN; i++) {
    if (x[i] != y[i]) {
      allEqual = uint(0);
      break;
    }
  }
  result[0] = allEqual;
}
`,pe=({inputs:t,output:e,target:r})=>(_({module:{name:"equalAll",vs:ve},inputs:t,output:e,operationType:e.type==="uint32"?t.x.type:e.type,outputBuffer:r}),{success:!0}),xe=`void row_length(in TYPE x[X_LEN], out float result[1]) {
  float sum = 0.0;
  for (int i = 0; i < X_LEN; i++) {
    sum += float(x[i]) * float(x[i]);
  }
  result[0] = sqrt(sum);
}
`,Ee=({inputs:t,output:e,target:r})=>(_({module:{name:"row_length",vs:xe},inputs:t,output:e,operationType:"float32",outputBuffer:r}),{success:!0}),ye=async({inputs:t,output:e,target:r})=>{const{segments:n}=t,i=r.device,u=b("result",e.type,e.size),o=n.type,s=Y(n,o,i),a=new y(i,{vs:`#version 300 es

void main() {
  TYPE result[RESULT_LEN];
  segmentedMap(result);
  set_result(result);
}
`,defines:{TYPE:"uint",RESULT_LEN:e.size.toString(),SEGMENTS_LENGTH:n.length.toString()},modules:[C(n,e.type,o),Te(),u],bindings:{source_values_texture:s},vertexCount:1,instanceCount:e.length,feedbackBufferMode:"interleaved",outputs:u.varyings});try{return a.run({outputBuffers:{[u.varyings[0]]:r}}),{success:!0}}finally{a.destroy(),s.destroy()}};function Te(){return{name:"segmentedMap",vs:`
uint read_segment_start(int segmentIndex) {
  TYPE value[1];
  read_source_values(segmentIndex, value);
  return uint(value[0]);
}

void segmentedMap(out TYPE result[RESULT_LEN]) {
  uint vertexIndex = uint(gl_InstanceID);
  int low = 0;
  int high = SEGMENTS_LENGTH;

  while (low < high) {
    int mid = low + (high - low) / 2;
    uint midStart = read_segment_start(mid);
    if (midStart <= vertexIndex) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  uint segmentIndex = uint(max(low - 1, 0));
  uint segmentStart = read_segment_start(int(segmentIndex));
  result[0] = segmentIndex;
  result[1] = vertexIndex - segmentStart;
}
`}}var $e=async({inputs:t,output:e,target:r})=>{const n=$(m(e.type,1,e.normalized));return _({module:{name:"select",vs:""},inputs:t,output:e,operationType:e.type,outputBuffer:r,expression:i=>{const u=S("condition",t.condition,i,n),o=S("whenTrue",t.whenTrue,i,n),s=S("whenFalse",t.whenFalse,i,n);return`(${u} != ${n} ? ${o} : ${s})`}}),{success:!0}};function S(t,e,r,n){return r<e.size?`${t}[${r}]`:e.size===1?`${t}[0]`:n}var be=({inputs:t,output:e,target:r})=>{const n=b("result",e.type,e.size),i=new y(r.device,{vs:`#version 300 es

void main() {
  int result[1];
  result[0] = START + gl_InstanceID * STEP;
  set_result(result);
}
`,defines:{START:t.start.toString(),STEP:t.step.toString()},modules:[n],vertexCount:1,instanceCount:e.length,feedbackBufferMode:"interleaved",outputs:n.varyings});try{return i.run({outputBuffers:{[n.varyings[0]]:r}}),{success:!0}}finally{i.destroy()}},we=({inputs:t,output:e,target:r})=>{const{columns:n}=t;return _({module:{name:"swizzle",vs:"// swizzle expression handled inline"},expression:i=>`x[${n[i]}]`,inputs:{x:t.x},output:e,outputBuffer:r}),{success:!0}};export{F as arithmetic,_e as dot,pe as equalAll,re as extent,le as fround,fe as gather,ie as interleave,Ee as length,ye as segmentedMap,$e as select,be as sequence,we as swizzle};
