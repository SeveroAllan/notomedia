// Entrypoint da homologação: nunca permite iniciar em modo irrestrito
// quando a variável de segurança foi omitida ou configurada como false.
process.env['NOTO_PILOTO_RESTRITO'] = 'true';
await import('./server.js');
