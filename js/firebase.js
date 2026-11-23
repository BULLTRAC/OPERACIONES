/* ===== Firebase: Auth + Firestore en tiempo real (V16) =====
   - Login con usuario (se convierte en usuario@bulltrac.app) y contraseña.
   - Cada registro es su propio documento: colecciones vehiculos, conductores,
     viajes y registro (auditoría). Al guardar solo se suben los registros que
     cambiaron, así dos personas que editan cosas distintas no se pisan.
   - flota/cfg (catálogos, tipos, alertas) y flota/usuarios (usuarios y permisos,
     solo admin) son un documento cada uno.
   - onSnapshot: los cambios de otros aparecen al instante.
   - roles/{correo} = {rol: admin|editor|viewer}: lo usan las reglas; la app lo
     actualiza cuando el admin guarda usuarios.
   - Migración: la primera vez que entra el admin, los bloques antiguos
     (flota/vehiculos_0, viajes_0…) se copian al formato nuevo y luego se borran.
   - localStorage sigue como caché si no hay internet al abrir (sin subir nada). */
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserSessionPersistence }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection, writeBatch, onSnapshot }
  from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB-1H_iDXiEJqITndJl8wW-Unh47tDJcGw",
  authDomain: "bulttrac.firebaseapp.com",
  projectId: "bulttrac",
  storageBucket: "bulttrac.firebasestorage.app",
  messagingSenderId: "259384889132",
  appId: "1:259384889132:web:0cebb174770eb2ac4a6689"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const VERSION = 2;
const COLS = ['vehiculos', 'conductores', 'viajes', 'registro'];
const BLOQUES_V1 = ['vehiculos', 'conductores', 'viajes', 'cfg', 'usuarios'];
const APP_SCRIPTS = ['js/config.js', 'data/datos.js', 'js/core.js', 'js/buscable.js', 'js/vehiculos.js',
  'js/conductores.js', 'js/viajes.js', 'js/historial.js', 'js/configuracion.js', 'js/main.js'];
const MSG_KEY = 'flota_login_msg';

// Lo último que se sabe que está en la nube (JSON por id) para subir solo diferencias
const known = Object.fromEntries(COLS.map(c => [c, new Map()]));
let knownCfg = null, knownUsuarios = null;
let pendiente = false, timer = null, enCurso = Promise.resolve(true);
let appCargada = false, miRol = null, sinNube = false;

const cmp = (a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0);
const ordenarRegistro = arr => arr.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
function arreglo(col, d){
  if(col !== 'registro') return d[col];
  if(!Array.isArray(d.cfg.registro)) d.cfg.registro = [];
  return d.cfg.registro;
}

/* ---------- Lectura inicial ---------- */
async function descargarV2(){
  const [cfgS, usS, ...snaps] = await Promise.all([
    getDoc(doc(db, 'flota', 'cfg')), getDoc(doc(db, 'flota', 'usuarios')),
    ...COLS.map(c => getDocs(collection(db, c)))
  ]);
  const out = {};
  COLS.forEach((c, i) => {
    out[c] = snaps[i].docs.map(d => { known[c].set(d.id, d.data().json); return JSON.parse(d.data().json); });
  });
  out.vehiculos.sort(cmp); out.conductores.sort(cmp); out.viajes.sort(cmp); ordenarRegistro(out.registro);
  knownCfg = cfgS.exists() ? cfgS.data().json : null;
  knownUsuarios = usS.exists() ? usS.data().json : null;
  out.cfg = knownCfg ? JSON.parse(knownCfg) : {};
  out.cfg.usuarios = knownUsuarios ? JSON.parse(knownUsuarios) : [];
  out.cfg.registro = out.registro; delete out.registro;
  return out;
}
async function descargarV1(partes){   // formato anterior: bloques JSON partidos
  const out = {};
  await Promise.all(BLOQUES_V1.map(async b => {
    const n = partes[b] || 0;
    if(!n) return;
    const snaps = await Promise.all(Array.from({length: n}, (_, i) => getDoc(doc(db, 'flota', `${b}_${i}`))));
    out[b] = JSON.parse(snaps.map(s => (s.exists() ? s.data().json : '')).join(''));
  }));
  if(out.cfg && Array.isArray(out.usuarios)) out.cfg.usuarios = out.usuarios;
  delete out.usuarios;
  return out.cfg ? out : null;
}

/* ---------- Escritura: solo lo que cambió ---------- */
window.fbGuardar = function(){
  if(sinNube || miRol === 'viewer') return;   // el visor no escribe en la nube
  pendiente = true;
  clearTimeout(timer);
  timer = setTimeout(subir, 800);
};
function subir(){
  clearTimeout(timer);
  if(!pendiente || !auth.currentUser || !window.fbDatos) return enCurso;
  pendiente = false;
  enCurso = enCurso.then(async () => {
    const d = window.fbDatos();
    const ops = [], deshacer = [];
    COLS.forEach(c => {
      const vistos = new Set();
      (arreglo(c, d) || []).forEach(o => {
        if(!o || o.id == null) return;
        const id = String(o.id), j = JSON.stringify(o);
        vistos.add(id);
        if(known[c].get(id) === j) return;
        ops.push([doc(db, c, id), { json: j }]);
        known[c].set(id, j);
        deshacer.push(() => known[c].delete(id));
      });
      [...known[c].keys()].forEach(id => {
        if(vistos.has(id)) return;
        ops.push([doc(db, c, id), null]);
        const antes = known[c].get(id);
        known[c].delete(id);
        deshacer.push(() => known[c].set(id, antes));
      });
    });
    const { usuarios, registro, ...resto } = d.cfg;
    const jc = JSON.stringify(resto);
    if(jc !== knownCfg){ ops.push([doc(db, 'flota', 'cfg'), { json: jc }]); const a = knownCfg; knownCfg = jc; deshacer.push(() => knownCfg = a); }
    if(miRol === 'admin'){   // solo el admin puede cambiar usuarios/permisos
      const ju = JSON.stringify(usuarios || []);
      if(ju !== knownUsuarios){
        rolesOps(knownUsuarios ? JSON.parse(knownUsuarios) : [], usuarios || []).forEach(o => ops.push(o));
        ops.push([doc(db, 'flota', 'usuarios'), { json: ju }]);
        const a = knownUsuarios; knownUsuarios = ju; deshacer.push(() => knownUsuarios = a);
      }
    }
    try{
      for(let i = 0; i < ops.length; i += 400){
        const batch = writeBatch(db);
        ops.slice(i, i + 400).forEach(([ref, data]) => data ? batch.set(ref, data) : batch.delete(ref));
        await batch.commit();
      }
      return true;
    }catch(e){
      console.error('Error guardando en Firestore', e);
      deshacer.forEach(f => f());   // se reintenta en el próximo guardado
      if(typeof toast === 'function') toast('⚠️ No se pudo guardar en la nube. Se reintentará.', 'danger');
      return false;
    }
  });
  return enCurso;
}

/* Rol para las reglas: admin si es admin o gestiona usuarios; editor si tiene algún permiso que no sea "ver_"; si no, viewer */
function rolDeUsuario(u){
  const p = u.permisos || {};
  if(u.rol === 'admin' || p.gestionar_usuarios) return 'admin';
  return Object.keys(p).some(k => p[k] && !k.startsWith('ver_')) ? 'editor' : 'viewer';
}
function rolesOps(antes, ahora){
  const ops = [], vigentes = new Set();
  const correo = u => window.usuarioAEmail(u.usuario);
  ahora.forEach(u => {
    if(!u.usuario || !u.activo) return;
    vigentes.add(correo(u));
    ops.push([doc(db, 'roles', correo(u)), { rol: rolDeUsuario(u), nombre: u.nombre || '' }]);
  });
  new Set([...antes, ...ahora].filter(u => u.usuario).map(correo)).forEach(c => {
    if(!vigentes.has(c) && c !== auth.currentUser.email) ops.push([doc(db, 'roles', c), null]);
  });
  return ops;
}

/* ---------- Tiempo real ---------- */
let rTimer = null;
function programarRender(){
  clearTimeout(rTimer);
  rTimer = setTimeout(() => {
    const a = document.activeElement;   // no redibujar mientras alguien escribe en la tabla
    if(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.closest('#modal-backdrop')){ programarRender(); return; }
    try{ actualizarUICompleta(); renderTodo(); }catch(e){ console.error(e); }
    try{ localStorage.setItem(LS_KEY, JSON.stringify({ ...window.fbDatos(), usuarioActualId: state.usuarioActualId })); }catch(e){}
  }, 300);
}
function escuchar(){
  COLS.forEach(c => onSnapshot(collection(db, c), snap => {
    let cambio = false;
    const arr = arreglo(c, window.fbDatos());
    snap.docChanges().forEach(ch => {
      const id = ch.doc.id, i = arr.findIndex(x => x && String(x.id) === id);
      if(ch.type === 'removed'){
        if(!known[c].has(id)) return;
        known[c].delete(id); if(i >= 0) arr.splice(i, 1); cambio = true;
        return;
      }
      const j = ch.doc.data().json;
      if(known[c].get(id) === j) return;   // ya lo tenemos (o es nuestro propio cambio)
      known[c].set(id, j);
      const o = JSON.parse(j);
      if(i >= 0) arr[i] = o; else if(c === 'registro') arr.unshift(o); else arr.push(o);
      cambio = true;
    });
    if(cambio){ if(c === 'registro') ordenarRegistro(arr); programarRender(); }
  }, e => console.error('Escucha ' + c, e)));

  onSnapshot(doc(db, 'flota', 'cfg'), s => {
    if(!s.exists() || s.data().json === knownCfg) return;
    knownCfg = s.data().json;
    const nuevo = JSON.parse(knownCfg), d = window.fbDatos();
    Object.keys(d.cfg).forEach(k => { if(k !== 'usuarios' && k !== 'registro') delete d.cfg[k]; });
    Object.assign(d.cfg, nuevo);
    programarRender();
  }, e => console.error('Escucha cfg', e));

  onSnapshot(doc(db, 'flota', 'usuarios'), s => {
    if(!s.exists() || s.data().json === knownUsuarios) return;
    knownUsuarios = s.data().json;
    const d = window.fbDatos();
    d.cfg.usuarios = JSON.parse(knownUsuarios);
    const yo = d.cfg.usuarios.find(u => u.id === state.usuarioActualId);
    if(!yo || !yo.activo){ window.fbSalir('Tu usuario fue desactivado o eliminado.'); return; }
    programarRender();
  }, e => console.error('Escucha usuarios', e));
}

/* ---------- Migración desde el formato anterior (solo admin) ---------- */
async function migrar(partesViejas){
  pendiente = true;
  if(!(await subir())) throw new Error('No se pudieron subir los datos');   // sube todo (known está vacío)
  const batch = writeBatch(db);
  Object.entries(partesViejas || {}).forEach(([b, n]) => {
    for(let i = 0; i < n; i++) batch.delete(doc(db, 'flota', `${b}_${i}`));
  });
  batch.set(doc(db, 'flota', '_meta'), { version: VERSION, migrado: new Date().toISOString(), por: auth.currentUser.email });
  await batch.commit();
  if(typeof toast === 'function') toast('✅ Datos migrados al formato en tiempo real', 'success');
}

/* ---------- Sesión ---------- */
window.fbEntrar = async (correo, clave) => {
  await setPersistence(auth, browserSessionPersistence);   // la sesión dura mientras la pestaña esté abierta
  return signInWithEmailAndPassword(auth, correo, clave);
};
window.fbSalir = async (mensaje) => {
  try{ await subir(); }catch(e){}
  try{ if(mensaje) sessionStorage.setItem(MSG_KEY, mensaje); }catch(e){}
  await signOut(auth);
};
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') subir(); });
window.addEventListener('beforeunload', e => { if(pendiente){ subir(); e.preventDefault(); e.returnValue = ''; } });

function cargarScripts(){
  return APP_SCRIPTS.reduce((p, src) => p.then(() => new Promise((ok, err) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => err(new Error('No se pudo cargar ' + src));
    document.body.appendChild(s);
  })), Promise.resolve());
}

onAuthStateChanged(auth, async user => {
  if(!user){
    if(appCargada){ location.reload(); return; }   // al cerrar sesión se reinicia la app limpia
    loginOcupado(false);
    mostrarLogin();
    let msg = null;
    try{ msg = sessionStorage.getItem(MSG_KEY); sessionStorage.removeItem(MSG_KEY); }catch(e){}
    if(msg) errorLogin(msg);
    return;
  }
  if(appCargada) return;
  appCargada = true;
  loginOcupado(true, 'Cargando datos…');
  window.FB_EMAIL = (user.email || '').toLowerCase();
  let aMigrar = null;
  try{
    const r = await getDoc(doc(db, 'roles', window.FB_EMAIL));
    miRol = r.exists() ? r.data().rol : null;
    if(!miRol){ appCargada = false; await window.fbSalir('Tu cuenta no tiene rol asignado. Pídele al administrador que guarde tu usuario en Configuración › Usuarios.'); return; }
    const meta = await getDoc(doc(db, 'flota', '_meta'));
    const m = meta.exists() ? meta.data() : null;
    if(m && m.version === VERSION){
      window.FB_DATOS = await descargarV2();
    }else{
      if(miRol !== 'admin'){ appCargada = false; await window.fbSalir('La app se está actualizando. El administrador debe entrar primero.'); return; }
      aMigrar = (m && m.partes) || {};
      window.FB_DATOS = m ? await descargarV1(aMigrar) : null;
    }
  }catch(e){
    console.error('No se pudieron leer los datos de Firestore', e);
    window.FB_DATOS = null;   // se usa la caché local de este navegador
    sinNube = true;
    setTimeout(() => { if(typeof toast === 'function') toast('⚠️ Sin conexión: mostrando datos de este equipo. Los cambios NO se guardarán en la nube; recarga cuando tengas internet.', 'danger'); }, 500);
  }
  try{
    await cargarScripts();
  }catch(e){
    errorLogin(e.message);
    loginOcupado(false);
    return;
  }
  loginOcupado(false);
  if(sinNube || !auth.currentUser) return;
  if(aMigrar){
    try{ await migrar(aMigrar); }
    catch(e){ console.error('Migración', e); toast('⚠️ No se pudo migrar. Recarga la página para reintentar.', 'danger'); return; }
  }
  escuchar();
});
