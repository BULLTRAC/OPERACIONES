(function init(){
  const d=new Date();
  const meses=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  $('#topbar-date').textContent=`${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
  restaurarSesion();
  actualizarUICompleta();
  const primeraVista = ['resumen','viajes','historico','vehiculos','conductores'].find(v => puede(VISTA_META[v].permiso)) || 'resumen';
  cambiarVista(primeraVista);
  renderTodo();
  guardar();
})();
