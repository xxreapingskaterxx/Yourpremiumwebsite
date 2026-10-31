/* Cinematic render pipeline shared by every page's board scene.
   Adds three things the plain renderer can't do on its own:
   - an environment map, so metal surfaces pick up cyan/amber reflections
   - a glossy mirror floor that reflects the board, towers and frame
   - bloom, so anything bright (LEDs, cables, lit traces, sprites) glows for real
   Everything renders into a linear HDR target and is encoded to sRGB once, in the composite.
   Custom ShaderMaterials authored for direct-to-screen output should wrap their final colour
   in pow(c, vec3(2.2)) so they keep their look. */
(function(){
  "use strict";

  var VERT = 'varying vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }';

  function passMat(frag, uniforms){
    return new THREE.ShaderMaterial({ uniforms: uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
  }

  function buildEnv(renderer){
    /* a dark studio with a cyan softbox overhead, an amber strip to one side and cool fill */
    var env = new THREE.Scene();
    env.background = new THREE.Color(0x010204);
    function panel(color, w, h, pos, rot){
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide }));
      m.position.fromArray(pos); m.rotation.fromArray(rot); env.add(m);
    }
    panel(0x7fe9ff, 6, 3, [0, 6, 0], [Math.PI / 2, 0, 0]);
    panel(0xffb224, .8, 6, [-7, 1, -2], [0, Math.PI / 2, 0]);
    panel(0x2b5d8a, 10, 4, [6, 0, -6], [0, -Math.PI / 4, 0]);
    panel(0xffffff, 2, 1, [3, 4, 5], [-Math.PI / 4, Math.PI / 6, 0]);
    var pmrem = new THREE.PMREMGenerator(renderer);
    var tex = pmrem.fromScene(env, .02).texture;
    pmrem.dispose();
    return tex;
  }

  function create(renderer, scene, camera, opts){
    opts = opts || {};
    var gl2 = renderer.capabilities.isWebGL2;
    var TYPE = gl2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    var bg = (opts.background || new THREE.Color(0x05080d)).clone();
    var bgLinear = bg.clone().convertSRGBToLinear();

    scene.environment = buildEnv(renderer);

    /* phones keep the mirror floor and antialiasing: without the reflections the board under the build looks flat */
    var msaa = gl2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    function rt(samples){
      return new THREE.WebGLRenderTarget(1, 1, { type: TYPE, samples: msaa ? samples : 0, depthBuffer: true });
    }
    /* phones get 2x MSAA: 4x half-float buffers at phone resolution can push iOS Safari into dropping the context */
    var main = rt(opts.small ? 2 : 4);
    var mirror = rt(0), mirrorOn = true;
    var lv = [rt(0), rt(0), rt(0), rt(0), rt(0), rt(0)]; /* three bloom levels, ping-pong pairs */
    lv.forEach(function(r){ r.depthBuffer = false; });

    var quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); quad.frustumCulled = false; quadScene.add(quad);
    function pass(mat, target){ quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); }

    var bright = passMat([
      'uniform sampler2D tDiffuse; uniform float uTh; uniform vec2 uTexel; varying vec2 vUv;',
      /* average a 2x2 block of source pixels so one-pixel sparkles cannot pop the glow on and off */
      'vec3 tap(vec2 o){ vec3 c = texture2D(tDiffuse, vUv + o * uTexel).rgb; float l = max(c.r, max(c.g, c.b)); return c * smoothstep(uTh, uTh + .35, l) / (1. + l * .25); }',
      'void main(){ vec3 c = tap(vec2(-.5, -.5)) + tap(vec2(.5, -.5)) + tap(vec2(-.5, .5)) + tap(vec2(.5, .5));',
      '  gl_FragColor = vec4(c * .25 * 1.2, 1.); }'
    ].join('\n'), { tDiffuse: { value: null }, uTh: { value: opts.threshold || .55 }, uTexel: { value: new THREE.Vector2(1, 1) } });

    var blur = passMat([
      'uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;',
      'void main(){',
      '  vec3 c = texture2D(tDiffuse, vUv).rgb * .227027;',
      '  c += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * .3162162; c += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * .3162162;',
      '  c += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * .0702703; c += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * .0702703;',
      '  gl_FragColor = vec4(c, 1.); }'
    ].join('\n'), { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });

    var composite = passMat([
      'uniform sampler2D tScene, tB0, tB1, tB2; uniform float uStrength; varying vec2 vUv;',
      'vec3 toSRGB(vec3 c){ c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }',
      'void main(){',
      '  vec3 c = texture2D(tScene, vUv).rgb;',
      '  vec3 b = texture2D(tB0, vUv).rgb * .9 + texture2D(tB1, vUv).rgb * .8 + texture2D(tB2, vUv).rgb * .7;',
      '  c += b * uStrength;',
      /* soft shoulder so stacked additive glows roll off instead of clipping to flat white */
      '  c = c / (1. + max(vec3(0.), c - .85) * .6);',
      /* a little noise so dark glow gradients don't break into visible bands on phone screens */
      '  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
      '  gl_FragColor = vec4(toSRGB(c) + (n - .5) / 255., 1.); }'
    ].join('\n'), { tScene: { value: null }, tB0: { value: null }, tB1: { value: null }, tB2: { value: null }, uStrength: { value: opts.strength || .75 } });

    /* glossy floor: blurred planar reflection, fresnel-weighted, fogged like the rest of the scene */
    var texMat = new THREE.Matrix4();
    var floorMat = new THREE.ShaderMaterial({
      uniforms: {
        tMirror: { value: mirror ? mirror.texture : null }, uTexMat: { value: texMat },
        uBase: { value: bgLinear.clone().multiplyScalar(1.6) }, uFogColor: { value: bgLinear },
        uFog: { value: scene.fog ? scene.fog.density : 0 }, uStrength: { value: mirror ? (opts.reflect || .55) : 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
        /* two soft pools of light painted straight into the floor (x, z, radius, strength) */
        uGlowA: { value: new THREE.Vector4(0, 0, 1, 0) }, uGlowColA: { value: new THREE.Color() },
        uGlowB: { value: new THREE.Vector4(0, 0, 1, 0) }, uGlowColB: { value: new THREE.Color() }
      },
      vertexShader: [
        'uniform mat4 uTexMat; varying vec4 vM; varying vec3 vW; varying float vD;',
        'void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vM = uTexMat * w;',
        '  vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D tMirror; uniform vec3 uBase, uFogColor; uniform float uFog, uStrength; uniform vec2 uTexel;',
        'uniform vec4 uGlowA, uGlowB; uniform vec3 uGlowColA, uGlowColB;',
        'varying vec4 vM; varying vec3 vW; varying float vD;',
        'vec3 pool(vec4 g, vec3 c){ if (g.w <= 0.) return vec3(0.); vec2 d = (vW.xz - g.xy) / g.z; return c * g.w * exp(-dot(d, d) * 3.); }',
        'void main(){',
        '  vec3 col = uBase;',
        '  if (uStrength > 0.){',
        '    vec2 uv = vM.xy / vM.w; vec2 s = uTexel * (1.5 + vD * .06);',
        '    vec3 r = texture2D(tMirror, uv).rgb * .2;',
        '    r += (texture2D(tMirror, uv + vec2(s.x, 0.)).rgb + texture2D(tMirror, uv - vec2(s.x, 0.)).rgb',
        '        + texture2D(tMirror, uv + vec2(0., s.y)).rgb + texture2D(tMirror, uv - vec2(0., s.y)).rgb) * .13;',
        '    r += (texture2D(tMirror, uv + s * 2.).rgb + texture2D(tMirror, uv - s * 2.).rgb',
        '        + texture2D(tMirror, uv + vec2(s.x, -s.y) * 2.).rgb + texture2D(tMirror, uv + vec2(-s.x, s.y) * 2.).rgb) * .07;',
        '    vec3 v = normalize(cameraPosition - vW);',
        '    float fres = .35 + .65 * pow(1. - max(v.y, 0.), 4.);',
        '    col += r * uStrength * fres;',
        '  }',
        '  col += pool(uGlowA, uGlowColA) + pool(uGlowB, uGlowColB);',
        '  float f = 1. - exp(-uFog * uFog * vD * vD);',
        '  gl_FragColor = vec4(mix(col, uFogColor, f), 1.);',
        '}'
      ].join('\n')
    });

    var mirrorCam = new THREE.PerspectiveCamera();
    var bias = new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);
    var size = new THREE.Vector2(), clear = new THREE.Color();

    function resize(){
      renderer.getDrawingBufferSize(size);
      var w = Math.max(1, size.x), h = Math.max(1, size.y);
      main.setSize(w, h);
      bright.uniforms.uTexel.value.set(1 / w, 1 / h);
      if (mirrorOn){ mirror.setSize(Math.ceil(w / 2), Math.ceil(h / 2)); floorMat.uniforms.uTexel.value.set(2 / w, 2 / h); }
      for (var i = 0; i < 3; i++){
        var d = Math.pow(2, i + 1);
        lv[i * 2].setSize(Math.ceil(w / d), Math.ceil(h / d));
        lv[i * 2 + 1].setSize(Math.ceil(w / d), Math.ceil(h / d));
      }
    }

    /* `ground` is hidden during the mirror pass; `look` is the camera's look-at point */
    function render(ground, look){
      renderer.getClearColor(clear);
      var alpha = renderer.getClearAlpha();
      renderer.setClearColor(bgLinear, 1);

      if (mirrorOn && ground){
        mirrorCam.copy(camera);
        mirrorCam.position.set(camera.position.x, -camera.position.y, camera.position.z);
        mirrorCam.up.set(0, -1, 0);
        mirrorCam.lookAt(look.x, -look.y, look.z);
        mirrorCam.updateMatrixWorld();
        texMat.copy(bias).multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);
        ground.visible = false;
        renderer.setRenderTarget(mirror);
        renderer.render(scene, mirrorCam);
        ground.visible = true;
      }

      renderer.setRenderTarget(main);
      renderer.render(scene, camera);

      bright.uniforms.tDiffuse.value = main.texture;
      var src = main;
      for (var i = 0; i < 3; i++){
        var a = lv[i * 2], b = lv[i * 2 + 1];
        if (i === 0) pass(bright, a);
        else { blur.uniforms.tDiffuse.value = src.texture; blur.uniforms.uDir.value.set(1 / a.width, 0); pass(blur, a); }
        blur.uniforms.tDiffuse.value = a.texture; blur.uniforms.uDir.value.set(1 / a.width, 0); pass(blur, b);
        blur.uniforms.tDiffuse.value = b.texture; blur.uniforms.uDir.value.set(0, 1 / a.height); pass(blur, a);
        src = a;
      }
      composite.uniforms.tScene.value = main.texture;
      composite.uniforms.tB0.value = lv[0].texture;
      composite.uniforms.tB1.value = lv[2].texture;
      composite.uniforms.tB2.value = lv[4].texture;
      pass(composite, null);

      renderer.setClearColor(clear, alpha);
    }

    /* keep the frame rate up on slower phones: when frames run long, give up the least visible quality first —
       sharpness down to one pixel per CSS pixel, then antialiasing, then the floor reflection, then a little more sharpness */
    var maxPr = Math.min(window.devicePixelRatio || 1, opts.small ? 1.5 : 1.75), pr = maxPr;
    var frameAvg = 1 / 60, lastQ = performance.now() + 1500, cssSize = new THREE.Vector2();
    function setPr(v){ pr = v; renderer.getSize(cssSize); renderer.setPixelRatio(v); renderer.setSize(cssSize.x, cssSize.y, false); resize(); }
    function adapt(dt, now){
      frameAvg += (dt - frameAvg) * .06;
      if (now - lastQ < 1000 || frameAvg < 1 / 45) return;
      lastQ = now; frameAvg = 1 / 50;
      if (pr > 1) setPr(Math.max(1, pr - .25));
      else if (main.samples > 0){ main.samples = 0; main.dispose(); }
      else if (mirrorOn){ mirrorOn = false; floorMat.uniforms.uStrength.value = 0; mirror.dispose(); }
      else if (pr > .75) setPr(.75);
    }
    function quality(){ return 'res ' + pr.toFixed(2) + ' aa ' + main.samples + (mirrorOn ? ' mirror' : ''); }

    return { floorMaterial: floorMat, resize: resize, render: render, adapt: adapt, quality: quality };
  }

  window.DWBFX = { create: create };
})();
