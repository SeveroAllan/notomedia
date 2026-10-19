/**
 * Gera formas equivalentes de um telefone brasileiro para lidar com a
 * representação do WhatsApp, que pode omitir o nono dígito do celular.
 */
export function gerarVariantesTelefoneBrasileiro(telefone: string): string[] {
  const digitos = telefone.replace(/\D/g, '');
  if (!digitos) return [];

  const locais = new Set<string>();
  const numeroLocal = digitos.startsWith('55') && digitos.length >= 12 ? digitos.slice(2) : digitos;
  locais.add(numeroLocal);

  if (numeroLocal.length === 11 && numeroLocal[2] === '9') {
    locais.add(`${numeroLocal.slice(0, 2)}${numeroLocal.slice(3)}`);
  } else if (numeroLocal.length === 10) {
    locais.add(`${numeroLocal.slice(0, 2)}9${numeroLocal.slice(2)}`);
  }

  const variantes = new Set<string>([digitos]);
  for (const local of locais) {
    variantes.add(local);
    variantes.add(`55${local}`);
  }
  return [...variantes];
}
