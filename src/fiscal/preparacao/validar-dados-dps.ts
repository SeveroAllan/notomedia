/** Valida formato/consistência local; não substitui consulta cadastral ou XSD oficial. */
import { validarCpf } from '../../paciente/validar-cpf.js';
import type { ConfigPrestador, EmissaoInput } from '../../io/fiscal/montar-dps.js';
import type { PendenciaFiscal } from './preparar-emissao.js';
function validarCnpj(documento: string): boolean {
  if (!/^\d{14}$/.test(documento) || /^(\d)\1+$/.test(documento)) return false;
  for (const tamanho of [12, 13]) {
    let soma = 0, peso = tamanho - 7;
    for (let i = 0; i < tamanho; i++) { soma += Number(documento[i]) * peso; peso = peso === 2 ? 9 : peso - 1; }
    const resto = soma % 11;
    if (Number(documento[tamanho]) !== (resto < 2 ? 0 : 11 - resto)) return false;
  }
  return true;
}
export function validarDadosDps(input: EmissaoInput, cfg: ConfigPrestador): PendenciaFiscal[] {
  const erros: PendenciaFiscal[] = [];
  const exigir = (valido: boolean, campo: string, mensagem: string) => {
    if (!valido) erros.push({ campo, codigo: 'DADO_INVALIDO', mensagem });
  };
  const doc = cfg.cnpj.replace(/\D/g, '');
  exigir(doc.length === 11 ? validarCpf(doc) : validarCnpj(doc), 'prestador.documento', 'Conferir CPF/CNPJ do emitente.');
  if (input.tomador.CPF) {
    exigir(validarCpf(input.tomador.CPF), 'tomador.cpf', 'Conferir o CPF do tomador.');
  } else if (input.tomador.CNPJ) {
    exigir(validarCnpj(input.tomador.CNPJ.replace(/\D/g, '')), 'tomador.cnpj', 'Conferir o CNPJ do tomador.');
  } else {
    exigir(false, 'tomador.documento', 'Informar o CPF ou CNPJ do tomador.');
  }
  exigir([1, 2].includes(cfg.ambiente), 'ambiente', 'Confirmar produção ou homologação.');
  exigir(/^\d{7}$/.test(cfg.codMunicipio), 'municipio', 'Conferir o código IBGE do emitente.');
  exigir(/^\d{1,5}$/.test(cfg.serie ?? '') && Number(cfg.serie) <= 49999, 'serie', 'Informar série da DPS de 0 a 49999 para emissão pelo aplicativo próprio.');
  exigir(/^[1-9]\d{0,14}$/.test(input.nDPS), 'numeroDps', 'Conferir numeração da DPS.');
  exigir(input.tomador.xNome.trim().length >= 2 && input.tomador.xNome.length <= 150, 'tomador.nome', 'Conferir nome do tomador.');
  if (input.tomador.end) {
    const e = input.tomador.end;
    exigir(/^\d{7}$/.test(e.cMun) && /^\d{8}$/.test(e.CEP), 'tomador.endereco', 'Conferir município e CEP do endereço.');
  }
  return erros;
}
