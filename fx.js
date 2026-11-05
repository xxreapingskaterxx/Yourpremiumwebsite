/* Cinematic render pipeline shared by every page's board scene.
   Adds what the plain renderer can't do on its own:
   - a studio environment map, so metal picks up believable softbox reflections
   - a circuit board floor: gold traces, vias, chips and capacitors, lit and reflecting the scene
   - soft contact and cast shadows on that floor, so objects sit on it instead of floating
   - bloom, so anything bright (LEDs, lit traces, sprites) glows for real
   - filmic tone mapping and a lens vignette, so highlights roll off the way a camera's do
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
    /* a dark photo studio: a big overhead softbox, a long strip light each side, a dim bounce from the floor.
       Values above 1 give real highlights on metal. A touch of warm and cool keeps it from looking grey */
    var env = new THREE.Scene();
    env.background = new THREE.Color(0x07090c);
    function panel(color, power, w, h, pos, rot){
      var mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      mat.color.set(color).multiplyScalar(power);
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.fromArray(pos); m.rotation.fromArray(rot); env.add(m);
    }
    panel(0xfff4e6, 4, 8, 5, [0, 7, 1], [Math.PI / 2, 0, 0]);
    panel(0xffd7a0, 2.6, .9, 7, [-7, 2, -1], [0, Math.PI / 2, 0]);
    panel(0xbfdcff, 3, 1.2, 7, [7, 2, 2], [0, -Math.PI / 2, 0]);
    panel(0x8fa6bd, .8, 12, 5, [0, 1, -8], [0, 0, 0]);
    panel(0xffffff, 3, 3, 1.2, [2, 3.5, 7], [-Math.PI / 6, Math.PI, 0]);
    panel(0x1a2028, 1, 16, 16, [0, -4, 0], [-Math.PI / 2, 0, 0]);
    var pmrem = new THREE.PMREMGenerator(renderer);
    var tex = pmrem.fromScene(env, .015).texture;
    pmrem.dispose();
    return tex;
  }

  /* a little repeatable random, so every visit gets the same board */
  function lcg(seed){ return function(){ seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

  /* Paints the whole board into one texture and places its 3D parts.
     traces: the page's routed traces. ext: half the board's width. clear(x, z): true where a page needs open floor */
  function buildBoard(renderer, scene, floorMat, traces, ext, clear, small){
    var S = Math.min(small ? 2048 : 4096, renderer.capabilities.maxTextureSize);
    var c = document.createElement('canvas'); c.width = c.height = S;
    var g = c.getContext('2d'), k = S / (2 * ext), r = lcg(7321);
    function X(v){ return (v + ext) * k; }
    function line(pts, w, color){
      g.strokeStyle = color; g.lineWidth = w * k; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath(); g.moveTo(X(pts[0][0]), X(pts[0][1]));
      for (var i = 1; i < pts.length; i++) g.lineTo(X(pts[i][0]), X(pts[i][1]));
      g.stroke();
    }
    function via(x, z, rad){
      g.fillStyle = '#a8864a'; g.beginPath(); g.arc(X(x), X(z), rad * k, 0, 6.283); g.fill();
      g.fillStyle = '#04060a'; g.beginPath(); g.arc(X(x), X(z), rad * .48 * k, 0, 6.283); g.fill();
    }
    /* matte black solder mask with a slight mottle */
    g.fillStyle = '#0b1118'; g.fillRect(0, 0, S, S);
    var tile = document.createElement('canvas'); tile.width = tile.height = 256;
    var tg = tile.getContext('2d'), id = tg.createImageData(256, 256);
    for (var n = 0; n < id.data.length; n += 4){ var v = 110 + r() * 40; id.data[n] = id.data[n + 1] = id.data[n + 2] = v; id.data[n + 3] = 14; }
    tg.putImageData(id, 0, 0);
    g.fillStyle = g.createPattern(tile, 'repeat'); g.fillRect(0, 0, S, S);
    /* copper pours showing faintly through the mask */
    for (var p = 0; p < 26; p++){
      g.fillStyle = 'rgba(70,96,120,' + (.025 + r() * .035) + ')';
      g.fillRect(X((r() * 2 - 1) * ext), X((r() * 2 - 1) * ext), (6 + r() * 26) * k, (6 + r() * 26) * k);
    }
    /* dense signal routing under the mask: parallel buses at 45 degree bends */
    var dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]], buses = small ? 150 : 300;
    for (var b = 0; b < buses; b++){
      var bx = Math.round((r() * 2 - 1) * ext), bz = Math.round((r() * 2 - 1) * ext), d = Math.floor(r() * 4) * 2;
      var lanes = 2 + Math.floor(r() * 7), segs = [], cx = 0, cz = 0, nseg = 2 + Math.floor(r() * 3);
      for (var q = 0; q < nseg; q++){
        var L = 3 + r() * 11; segs.push([d, L]); d = (d + (r() < .5 ? 1 : 7)) % 8;
      }
      for (var l = 0; l < lanes; l++){
        var off = l * .34, pts = [[bx + off, bz - off]]; cx = bx + off; cz = bz - off;
        segs.forEach(function(sg){ cx += dirs[sg[0]][0] * sg[1]; cz += dirs[sg[0]][1] * sg[1]; pts.push([cx, cz]); });
        line(pts, .085, 'rgb(23,33,43)');
      }
    }
    /* the routed traces the page's signals run along: gold where exposed, copper under mask otherwise */
    traces.forEach(function(t){
      var pts = t.pts.map(function(v){ return [v.x, v.z]; });
      if (t.amber){ line(pts, .22, 'rgb(10,14,18)'); line(pts, .15, '#a07c3e'); }
      else { line(pts, .15, 'rgb(30,42,54)'); }
      via(pts[0][0], pts[0][1], .24); via(pts[pts.length - 1][0], pts[pts.length - 1][1], .24);
    });
    /* stitching vias */
    for (var s = 0, ns = small ? 320 : 640; s < ns; s++){
      via(Math.round((r() * 2 - 1) * ext), Math.round((r() * 2 - 1) * ext), .13 + r() * .07);
    }
    /* parts: painted footprint here, real geometry below */
    var dummy = new THREE.Object3D(), chips = [], caps = [], smds = [];
    function free(x, z, m){ return !clear(x, z) && !clear(x - m, z - m) && !clear(x + m, z + m) && !clear(x - m, z + m) && !clear(x + m, z - m); }
    g.textBaseline = 'middle'; g.textAlign = 'left';
    function silk(txt, x, z, size){ g.fillStyle = 'rgba(205,212,218,.72)'; g.font = '600 ' + Math.round(size * k) + 'px monospace'; g.fillText(txt, X(x), X(z)); }
    var nChips = small ? 34 : 62, tries = 0;
    while (chips.length < nChips && tries++ < 900){
      var cw = 2.2 + r() * 3.6, cd = r() < .5 ? cw : 1.3 + r() * 1.6, cxx = (r() * 2 - 1) * (ext - 6), czz = (r() * 2 - 1) * (ext - 6);
      if (!free(cxx, czz, Math.max(cw, cd) + 1)) continue;
      chips.push([cxx, czz, cw, cd]);
      /* gold legs down every side */
      g.fillStyle = '#c9a25a';
      for (var px = -cw / 2 + .16; px < cw / 2 - .08; px += .3){
        g.fillRect(X(cxx + px), X(czz - cd / 2 - .28), .13 * k, (cd + .56) * k);
      }
      if (cd === cw) for (var pz = -cd / 2 + .16; pz < cd / 2 - .08; pz += .3){
        g.fillRect(X(cxx - cw / 2 - .28), X(czz + pz), (cw + .56) * k, .13 * k);
      }
      /* its shadow on the board */
      g.save(); g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = .7 * k; g.fillStyle = '#05070a';
      g.fillRect(X(cxx - cw / 2), X(czz - cd / 2), cw * k, cd * k); g.restore();
      silk('U' + (chips.length + 1), cxx - cw / 2, czz - cd / 2 - .72, .46);
    }
    tries = 0;
    var nCaps = small ? 34 : 70;
    while (caps.length < nCaps && tries++ < 900){
      var rad = .45 + r() * .55, hx = (r() * 2 - 1) * (ext - 4), hz = (r() * 2 - 1) * (ext - 4);
      if (!free(hx, hz, rad + 1)) continue;
      caps.push([hx, hz, rad, .9 + r() * 1.1]);
      g.save(); g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = .5 * k;
      g.strokeStyle = 'rgba(205,212,218,.26)'; g.lineWidth = .05 * k; g.fillStyle = '#05070a';
      g.beginPath(); g.arc(X(hx), X(hz), (rad + .1) * k, 0, 6.283); g.fill(); g.stroke(); g.restore();
      silk('C' + (caps.length + 1), hx + rad + .22, hz, .34);
    }
    tries = 0;
    var nSmd = small ? 120 : 340;
    while (smds.length < nSmd && tries++ < 3000){
      var sx = Math.round(((r() * 2 - 1) * (ext - 3)) * 4) / 4, sz = Math.round(((r() * 2 - 1) * (ext - 3)) * 4) / 4, turn = r() < .5;
      if (!free(sx, sz, 1)) continue;
      smds.push([sx, sz, turn]);
      g.fillStyle = '#c29a4e';
      if (turn){ g.fillRect(X(sx - .1), X(sz - .36), .2 * k, .18 * k); g.fillRect(X(sx - .1), X(sz + .18), .2 * k, .18 * k); }
      else { g.fillRect(X(sx - .36), X(sz - .1), .18 * k, .2 * k); g.fillRect(X(sx + .18), X(sz - .1), .18 * k, .2 * k); }
    }
    /* maker's marks, as on any real board */
    ['DWB-01  REV C', 'DA WEBSITE BUILDER', 'LAYER 4/6', '2.4 GHz', 'TEST POINTS'].forEach(function(t, i){
      for (var z = 0; z < 4; z++){
        var tx = (r() * 2 - 1) * (ext - 16), tz = (r() * 2 - 1) * (ext - 4);
        if (free(tx + 4, tz, 5)){ silk(t, tx, tz, .62 + (i % 2) * .2); break; }
      }
    });

    var tex = new THREE.CanvasTexture(c);
    tex.flipY = false; tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.anisotropy = Math.min(small ? 4 : 12, renderer.capabilities.getMaxAnisotropy());
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    floorMat.uniforms.tBoard.value = tex; floorMat.uniforms.uExt.value = ext;

    function instanced(geo, mat, list, place){
      var m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(function(it, i){ place(it); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
      m.frustumCulled = false; scene.add(m); return m;
    }
    dummy.rotation.set(0, 0, 0);
    instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: .5, metalness: 0, envMapIntensity: .22 }), chips, function(a){
      dummy.position.set(a[0], .16, a[1]); dummy.scale.set(a[2], .32, a[3]);
    });
    instanced(new THREE.CylinderGeometry(1, 1, 1, small ? 14 : 22), new THREE.MeshStandardMaterial({ color: 0x6f747a, roughness: .38, metalness: .9, envMapIntensity: .32 }), caps, function(a){
      dummy.position.set(a[0], a[3] / 2, a[1]); dummy.scale.set(a[2], a[3], a[2]);
    });
    instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2c241b, roughness: .55, metalness: 0, envMapIntensity: .25 }), smds, function(a){
      dummy.position.set(a[0], .07, a[1]); dummy.scale.set(a[2] ? .26 : .5, .14, a[2] ? .5 : .26);
    });
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
    ].join('\n'), { tDiffuse: { value: null }, uTh: { value: opts.threshold || .9 }, uTexel: { value: new THREE.Vector2(1, 1) } });

    var blur = passMat([
      'uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;',
      'void main(){',
      '  vec3 c = texture2D(tDiffuse, vUv).rgb * .227027;',
      '  c += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * .3162162; c += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * .3162162;',
      '  c += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * .0702703; c += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * .0702703;',
      '  gl_FragColor = vec4(c, 1.); }'
    ].join('\n'), { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });

    var composite = passMat([
      'uniform sampler2D tScene, tB0, tB1, tB2; uniform float uStrength, uExposure; varying vec2 vUv;',
      'vec3 toSRGB(vec3 c){ c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }',
      'void main(){',
      '  vec3 c = texture2D(tScene, vUv).rgb;',
      '  vec3 b = texture2D(tB0, vUv).rgb * .9 + texture2D(tB1, vUv).rgb * .8 + texture2D(tB2, vUv).rgb * .7;',
      '  c += b * uStrength;',
      /* a lens darkens toward its corners */
      '  vec2 q = vUv - .5; c *= 1. - .42 * smoothstep(.28, .95, length(q) * 1.25);',
      /* filmic curve (ACES fit): deep blacks, and highlights that roll off instead of clipping to flat white */
      '  c *= uExposure; c = clamp((c * (2.51 * c + .03)) / (c * (2.43 * c + .59) + .14), 0., 1.);',
      /* a little noise so dark glow gradients don't break into visible bands on phone screens */
      '  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
      '  gl_FragColor = vec4(toSRGB(c) + (n - .5) * 2.2 / 255., 1.); }'
    ].join('\n'), { tScene: { value: null }, tB0: { value: null }, tB1: { value: null }, tB2: { value: null }, uStrength: { value: opts.strength || .55 }, uExposure: { value: opts.exposure || 1.3 } });

    /* glossy floor: blurred planar reflection, fresnel-weighted, fogged like the rest of the scene */
    var texMat = new THREE.Matrix4(), SHADOWS = [0, 1, 2, 3, 4, 5, 6, 7];
    var floorMat = new THREE.ShaderMaterial({
      uniforms: {
        tMirror: { value: mirror ? mirror.texture : null }, uTexMat: { value: texMat },
        tBoard: { value: null }, uExt: { value: 64 }, uKeyDir: { value: new THREE.Vector3(-20, 30, 18).normalize() },
        uLook: { value: new THREE.Vector2() }, uShadow: { value: SHADOWS.map(function(){ return new THREE.Vector4(); }) },
        uShadowH: { value: SHADOWS.map(function(){ return new THREE.Vector2(); }) }, uFogColor: { value: bgLinear },
        uFog: { value: scene.fog ? scene.fog.density : 0 }, uStrength: { value: mirror ? (opts.reflect || 1) : 0 },
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
        'uniform sampler2D tMirror, tBoard; uniform vec3 uFogColor, uKeyDir; uniform float uFog, uStrength, uExt; uniform vec2 uTexel, uLook;',
        'uniform vec4 uGlowA, uGlowB; uniform vec3 uGlowColA, uGlowColB; uniform vec4 uShadow[8]; uniform vec2 uShadowH[8];',
        'varying vec4 vM; varying vec3 vW; varying float vD;',
        'vec3 pool(vec4 g, vec3 c){ if (g.w <= 0.) return vec3(0.); vec2 d = (vW.xz - g.xy) / g.z; return c * g.w * exp(-dot(d, d) * 3.); }',
        /* a soft rectangle: 1 inside, falling to 0 over radius r */
        'float box(vec2 p, vec2 c, vec2 h, float r){ vec2 d = max(abs(p - c) - h, 0.); return 1. - smoothstep(0., r, length(d)); }',
        'void main(){',
        '  vec3 s = texture2D(tBoard, vW.xz / (2. * uExt) + .5).rgb;',
        '  vec3 alb = pow(s, vec3(2.2));',
        /* gold is the only strongly warm thing on the board, so the paint itself says where the metal is */
        '  float metal = smoothstep(.1, .32, s.r - s.b);',
        '  vec3 v = normalize(cameraPosition - vW);',
        '  float nv = max(v.y, 0.);',
        /* a studio light over the part of the board in frame, falling off into the dark */
        '  vec2 fromLook = (vW.xz - uLook) / 62.;',
        '  float lit = .32 + 1.5 * exp(-dot(fromLook, fromLook) * 2.2);',
        '  vec3 h = normalize(uKeyDir + v);',
        '  float nh = max(h.y, 0.);',
        '  vec3 gold = vec3(1., .72, .32);',
        '  vec3 col = alb * (1. - metal * .75) * (.3 + .85 * uKeyDir.y) * lit;',
        '  col += mix(vec3(.05) * pow(nh, 22.), gold * 1.5 * pow(nh, 70.) + gold * alb * .5, metal) * lit;',
        '  float fres = pow(1. - nv, 5.);',
        '  float F = mix(.045 + .55 * fres, .62 + .38 * fres, metal);',
        '  if (uStrength > 0.){',
        '    vec2 uv = vM.xy / vM.w; vec2 t = uTexel * (2. + vD * .08) * (1.6 - metal);',
        '    vec3 r = texture2D(tMirror, uv).rgb * .2;',
        '    r += (texture2D(tMirror, uv + vec2(t.x, 0.)).rgb + texture2D(tMirror, uv - vec2(t.x, 0.)).rgb',
        '        + texture2D(tMirror, uv + vec2(0., t.y)).rgb + texture2D(tMirror, uv - vec2(0., t.y)).rgb) * .13;',
        '    r += (texture2D(tMirror, uv + t * 2.).rgb + texture2D(tMirror, uv - t * 2.).rgb',
        '        + texture2D(tMirror, uv + vec2(t.x, -t.y) * 2.).rgb + texture2D(tMirror, uv + vec2(-t.x, t.y) * 2.).rgb) * .07;',
        '    col += r * F * uStrength * 1.8 * mix(vec3(1.), gold, metal);',
        '  }',
        /* each object: a tight dark contact shadow plus a wider one thrown away from the key light */
        '  float shade = 1.; vec2 away = -uKeyDir.xz / uKeyDir.y;',
        '  for (int i = 0; i < 8; i++){ vec2 sh = uShadowH[i]; if (sh.y <= 0.) continue; vec4 b = uShadow[i];',
        '    float contact = box(vW.xz, b.xy, b.zw, 1.1 + sh.x * .12);',
        '    float thrown = box(vW.xz, b.xy + away * sh.x * .42, b.zw + abs(away) * sh.x * .34, 1.5 + sh.x * .55);',
        '    shade *= 1. - sh.y * max(contact * .9, thrown * .62); }',
        '  col *= shade;',
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
      floorMat.uniforms.uLook.value.set(look.x, look.z);
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

    /* keep the frame rate up on slower devices, without throwing quality away for nothing.
       Only sustained slowness counts: the first seconds after load (shader compiles, texture uploads)
       and one-off stalls (tab switches, the film scrolling back into view) are ignored.
       Levels: 0 full quality, 1 one pixel per CSS pixel, 2 no antialiasing, 3 no floor reflection.
       Desktops never step down: full sharpness, antialiasing and reflections always. Phones may go to level 3.
       When frames run comfortably fast again, quality steps back up. */
    var maxPr = Math.min(window.devicePixelRatio || 1, opts.small ? 1.5 : 1.75), pr = maxPr;
    var fullSamples = main.samples, reflect = floorMat.uniforms.uStrength.value;
    var level = 0, floorLevel = opts.small ? 3 : 0, recoveries = 0;
    var frameAvg = 1 / 60, lastNow = 0, lastQ = performance.now() + 4000, cssSize = new THREE.Vector2();
    function setPr(v){ pr = v; renderer.getSize(cssSize); renderer.setPixelRatio(v); renderer.setSize(cssSize.x, cssSize.y, false); resize(); }
    function apply(l){
      level = l;
      var wantPr = l >= 1 ? Math.min(1, maxPr) : maxPr;
      var wantSamples = l >= 2 ? 0 : fullSamples, wantMirror = l < 3;
      if (main.samples !== wantSamples){ main.samples = wantSamples; main.dispose(); }
      if (mirrorOn !== wantMirror){
        mirrorOn = wantMirror; floorMat.uniforms.uStrength.value = wantMirror ? reflect : 0;
        if (!wantMirror) mirror.dispose();
      }
      if (pr !== wantPr) setPr(wantPr); else resize();
    }
    function adapt(dt, now){
      var raw = lastNow ? (now - lastNow) / 1000 : 0; lastNow = now;
      if (raw <= 0 || raw > 1) return;                /* a pause (tab switch, film scrolled back into view) */
      frameAvg += (Math.min(raw, .1) - frameAvg) * .03; /* a one-off stall barely moves the average */
      if (now < lastQ) return;
      if (frameAvg > 1 / 40 && level < floorLevel){
        apply(level + 1); lastQ = now + 3000; frameAvg = 1 / 50;
      } else if (frameAvg < 1 / 57 && level > 0 && recoveries < 2){
        apply(level - 1); recoveries++; lastQ = now + 5000; frameAvg = 1 / 55;
      }
    }
    function quality(){ return 'res ' + pr.toFixed(2) + ' aa ' + main.samples + (mirrorOn ? ' mirror' : ''); }

    /* list of up to 8 objects sitting on the board: { x, z, hw, hd, h, s } (half width, half depth, height, strength 0-1) */
    function setShadow(i, x, z, hw, hd, h, s){
      floorMat.uniforms.uShadow.value[i].set(x, z, hw, hd);
      floorMat.uniforms.uShadowH.value[i].set(h, s);
    }
    return { floorMaterial: floorMat, resize: resize, render: render, adapt: adapt, quality: quality, setShadow: setShadow,
      board: function(traces, ext, clear){ buildBoard(renderer, scene, floorMat, traces, ext, clear, opts.small); } };
  }

  /* rods: list of [ax, ay, az, bx, by, bz]. All share one mesh, so a lattice costs a single draw call */
  function rods(list, radius, material, sides){
    var m = new THREE.InstancedMesh(new THREE.CylinderGeometry(radius, radius, 1, sides || 6), material, list.length);
    var o = new THREE.Object3D(), a = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
    list.forEach(function(r, i){
      a.set(r[0], r[1], r[2]); b.set(r[3], r[4], r[5]); dir.subVectors(b, a);
      o.position.addVectors(a, b).multiplyScalar(.5);
      o.scale.set(1, dir.length(), 1);
      o.quaternion.setFromUnitVectors(up, dir.normalize());
      o.updateMatrix(); m.setMatrixAt(i, o.matrix);
    });
    m.frustumCulled = false;
    return m;
  }
  window.DWBFX = { create: create, rods: rods, DUST: new THREE.Color(0xb9c2cc) };
})();
