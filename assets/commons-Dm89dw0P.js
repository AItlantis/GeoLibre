import{Us as x,Ws as y,bs as A,xs as S}from"./maplibre-Ezo9vfdW.js";async function _(e){return new Promise(n=>{const t=new A({controller:!1,gl:e,parameters:{depthCompare:"less-equal"},width:null,height:null,onDeviceInitialized:r=>{n({deckInstance:t,device:r})}})})}async function C(e){const{deckInstance:n,device:t}=await _(e);let r,s,a;try{return r=t.createTexture({format:"rgba8unorm",width:1,height:1,sampler:{minFilter:"linear",magFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"}}),s=new x(t,{vs:`#version 300 es
in vec2 pos;
out vec2 v_texcoord;
void main(void) {
    gl_Position = vec4(pos, 0.0, 1.0);
    v_texcoord = (pos + 1.0) / 2.0;
}
    `,fs:`#version 300 es
precision mediump float;
uniform sampler2D deckglTexture;
in vec2 v_texcoord;
out vec4 fragColor;

void main(void) {
    vec4 imageColor = texture(deckglTexture, v_texcoord);
    // FBO stores premultiplied RGBA (rgb already multiplied by alpha).
    // The composite blend (ONE, ONE_MINUS_SRC_ALPHA) handles premultiplied
    // input correctly; multiplying again here would darken overlays.
    fragColor = imageColor;
}
    `,bindings:{deckglTexture:r},parameters:{depthWriteEnabled:!1,depthCompare:"always",blendColorSrcFactor:"one",blendColorDstFactor:"one-minus-src-alpha",blendAlphaSrcFactor:"one",blendAlphaDstFactor:"one-minus-src-alpha",blendColorOperation:"add",blendAlphaOperation:"add"},geometry:new y({topology:"triangle-strip",attributes:{pos:{size:2,value:new Int8Array([-1,-1,1,-1,-1,1,-1,1,1,1,1,-1])}}}),vertexCount:6,disableWarnings:!0}),a=t.createFramebuffer({id:"deckfbo",width:1,height:1,colorAttachments:[r],depthStencilAttachment:"depth16unorm"}),n.setProps({_framebuffer:a,_customRender:i=>{if(i==="arcgis"){const o=t.gl;o.blendFuncSeparate(o.ONE,o.ONE_MINUS_SRC_ALPHA,o.ONE,o.ONE_MINUS_SRC_ALPHA),n._drawLayers(i)}else this.redraw()}}),{deck:n,texture:r,fbo:a,model:s}}catch(i){for(const o of[()=>n.finalize(),()=>s?.destroy(),()=>a?.destroy(),()=>r?.destroy()])try{o()}catch{}throw i}}function k(e,n){const{model:t,deck:r,fbo:s}=e,a=t.device;if(a instanceof S){const i=a.getParametersWebGL(36006),{width:o,height:u,views:h,viewState:b,...v}=n,m=window.devicePixelRatio,d=Math.round(o*m),c=Math.round(u*m);s.resize({width:d,height:c});const p=s.colorAttachments[0].texture??s.colorAttachments[0];p!==e.texture&&(e.texture=p,t.setBindings({deckglTexture:p}));const f={width:o,height:u,viewState:b||v};h&&(f.views=h),r.setProps(f),r.redraw("arcgis");const{gl:l}=a;i?(l.bindFramebuffer(36160,i),l.drawBuffers([36064])):l.drawBuffers([1029]),l.enable(3042),l.blendFuncSeparate(1,771,1,771),l.blendEquationSeparate(32774,32774);const w={handle:i,width:d,height:c,colorAttachments:[null]},g=a.beginRenderPass({framebuffer:w,parameters:{viewport:[0,0,d,c]},clearColor:!1,clearDepth:!1});try{t.draw(g)}finally{g.end()}}}function F(e){e.deck.finalize(),e.model.destroy(),e.fbo.destroy(),e.texture.destroy()}export{C as n,k as r,F as t};
