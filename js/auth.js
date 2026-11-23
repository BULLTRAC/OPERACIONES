/* ===== Inicio de sesión ===== */
const SESION_KEY = 'flota_sesion';

function mostrarLogin(){
  document.getElementById('login-screen').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => { const u = document.getElementById('login-user'); if(u) u.focus(); }, 60);
}
function ocultarLogin(){
  document.getElementById('login-screen').classList.add('hidden');
  document.body.style.overflow = '';
}
function restaurarSesion(){
  let id = null;
  try{ id = sessionStorage.getItem(SESION_KEY); }catch(e){}
  const u = cfg.usuarios.find(x => x.id === id && x.activo);
  if(u){ state.usuarioActualId = u.id; ocultarLogin(); }
  else mostrarLogin();
}
function verClave(){
  const i = document.getElementById('login-pass');
  i.type = i.type === 'password' ? 'text' : 'password';
}
function errorLogin(msg){
  const e = document.getElementById('login-error');
  e.textContent = msg; e.classList.remove('hidden');
  const c = document.querySelector('.login-card');
  c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
}
function iniciarSesion(ev){
  ev.preventDefault();
  const usuario = document.getElementById('login-user').value.trim().toLowerCase();
  const clave = document.getElementById('login-pass').value;
  const u = cfg.usuarios.find(x => (x.usuario || '').toLowerCase() === usuario);
  if(!u || u.clave !== clave) return errorLogin('Usuario o contraseña incorrectos.');
  if(!u.activo) return errorLogin('Este usuario está inactivo. Contacta al administrador.');
  try{ sessionStorage.setItem(SESION_KEY, u.id); }catch(e){}
  document.getElementById('login-error').classList.add('hidden');
  document.getElementById('login-pass').value = '';
  ocultarLogin();
  cambiarUsuarioActual(u.id);
}
function cerrarSesion(){
  try{ sessionStorage.removeItem(SESION_KEY); }catch(e){}
  if(typeof closeModal === 'function') closeModal();
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-pass').type = 'password';
  document.getElementById('login-error').classList.add('hidden');
  mostrarLogin();
}
