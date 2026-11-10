(() => {
  const signature = [
    "  __  __               _                  ____             _ ",
    " |  \\/  | ___ _ __ ___| |__   __ _ _ __  |  _ \\  _____   _| |",
    " | |\\/| |/ _ \\ '__/ __| '_ \\ / _` | '_ \\ | | | |/ _ \\ \\ / / |",
    " | |  | |  __/ | | (__| | | | (_| | | | || |_| |  __/\\ V /|_|",
    " |_|  |_|\\___|_|  \\___|_| |_|\\__,_|_| |_||____/ \\___| \\_/ (_)",
    "",
    "                  < Programmer Full-Stack />"
  ].join("\n");

  const notice = [
    "Desarrollo e ingeniería de software propiedad de Merchan.Dev y Epressivo Venezuela, C.A.",
    "",
    "Todos los derechos de propiedad intelectual e industrial sobre el código fuente, bases de datos, flujos de trabajo y arquitectura están reservados.",
    "Queda estrictamente prohibida la reproducción, modificación, copia, distribución, comercialización, ingeniería inversa, plagio o cualquier uso no autorizado, total o parcial, de los elementos desarrollados en este proyecto sin consentimiento previo, expreso y por escrito de los autores.",
    "Toda infracción será sujeta a las acciones civiles y penales correspondientes."
  ].join("\n");

  console.log("%c%s", "background:#1b2421;color:#43f5a3;font-weight:bold;padding:8px", signature);
  console.log("%c%s", "background:#26313b;color:#fff;font-weight:bold;padding:4px 8px", "MERCHAN.DEV  ×  EPRESSIVO VENEZUELA, C.A.");
  console.log("%c%s", "background:#1f2933;color:#d2e2ef;padding:4px 8px", notice);
})();
