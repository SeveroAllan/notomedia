/**
 * Renderização dos blocos de participantes do DANFSe v2.0 (Prestador, Tomador,
 * Destinatário e Intermediário) rigorosamente conforme o Portal Nacional da NFS-e.
 */

import type { DanfsePrestador, DanfseTomador } from './danfse-pdf-options.js';
import {
  type ContextoRenderizacaoDanfse,
  CORES_DANFSE,
  desenharCaixa,
  desenharCelula
} from './renderizar-secoes-danfse.js';
import {
  formatarDocumento,
  formatarTelefone,
  formatarCep,
  resolverNomeMunicipio
} from './formatadores-fiscais.js';

export function renderizarPrestador(ctx: ContextoRenderizacaoDanfse, prestador: DanfsePrestador = {}): void {
  const rowH = 16;
  let y = ctx.currentY;

  // Linha 1: Título | CNPJ | Indicador Municipal | Telefone
  desenharCelula(ctx, ctx.marginX, y, 130, rowH, '', 'PRESTADOR / FORNECEDOR', true);
  desenharCelula(ctx, ctx.marginX + 130, y, 140, rowH, 'CNPJ / CPF / NIF', formatarDocumento(prestador.cnpj));
  desenharCelula(ctx, ctx.marginX + 270, y, 145, rowH, 'Indicador Municipal (Inscrição)', prestador.inscricaoMunicipal || '-');
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'Telefone', formatarTelefone(prestador.telefone));
  y -= rowH;

  // Linha 2: Razão Social | Município / UF | Código IBGE / CEP
  const razaoSocial = (prestador.razaoSocial || prestador.nomeFantasia || '-').toUpperCase();
  const nomeMun = resolverNomeMunicipio(prestador.municipio, prestador.municipio);
  const munUf = `${nomeMun} / ${(prestador.uf || 'RS').toUpperCase()}`;
  const cepFmt = formatarCep(prestador.cep);
  const ibgeCep = `${prestador.municipio ? prestador.municipio.replace(/(\d{2})(\d{5})/, '$1.$2') : '43.14902'} / ${cepFmt}`;

  desenharCelula(ctx, ctx.marginX, y, 270, rowH, 'Nome / Nome Empresarial', razaoSocial, true);
  desenharCelula(ctx, ctx.marginX + 270, y, 145, rowH, 'Município / Sigla UF', munUf);
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'Código IBGE / CEP', ibgeCep);
  y -= rowH;

  // Linha 3: Endereço | E-mail
  desenharCelula(ctx, ctx.marginX, y, 415, rowH, 'Endereço', (prestador.endereco || '-').toUpperCase());
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'E-mail', (prestador.email || '-').toLowerCase());
  y -= rowH;

  // Linha 4: Simples Nacional | Regime de Apuração
  const optSimples = descreverOpcaoSimples(prestador);
  const regApuracao = descreverRegimeApuracaoSn(prestador);
  desenharCelula(ctx, ctx.marginX, y, 270, rowH, 'Simples Nacional na Data de Competência', optSimples);
  desenharCelula(ctx, ctx.marginX + 270, y, ctx.contentWidth - 270, rowH, 'Regime de Apuração Tributária pelo SN', regApuracao);
  y -= rowH;

  ctx.currentY = y;
}

function descreverOpcaoSimples(prestador: DanfsePrestador): string {
  if (prestador.opcaoSimplesNacional === 'nao_optante') return 'Não Optante';
  if (prestador.opcaoSimplesNacional === 'mei') return 'Optante - Microempreendedor Individual (MEI)';
  if (prestador.opcaoSimplesNacional === 'me_epp') return 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)';
  return prestador.simplesNacional ? 'Optante - Simples Nacional' : 'Não Optante';
}

function descreverRegimeApuracaoSn(prestador: DanfsePrestador): string {
  if (prestador.opcaoSimplesNacional !== 'me_epp') return '-';
  if (prestador.regimeApuracaoSn === 'regime_1') return 'Regime de apuração dos tributos federais e municipal pelo SN';
  if (prestador.regimeApuracaoSn === 'regime_2') return 'Regime de apuração dos tributos federais pelo SN e ISSQN por fora';
  if (prestador.regimeApuracaoSn === 'regime_3') return 'Regime de apuração dos tributos federais e municipal fora do SN';
  return '-';
}

export function renderizarTomador(
  ctx: ContextoRenderizacaoDanfse,
  tomador: DanfseTomador = {},
  prestador: DanfsePrestador = {}
): void {
  const rowH = 16;
  let y = ctx.currentY;

  // Linha 1: Título | CNPJ | Indicador Municipal | Telefone
  desenharCelula(ctx, ctx.marginX, y, 130, rowH, '', 'TOMADOR / ADQUIRENTE', true);
  desenharCelula(ctx, ctx.marginX + 130, y, 140, rowH, 'CNPJ / CPF / NIF', formatarDocumento(tomador.cpf));
  desenharCelula(ctx, ctx.marginX + 270, y, 145, rowH, 'Indicador Municipal (Inscrição)', tomador.inscricaoMunicipal || '-');
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'Telefone', formatarTelefone(tomador.telefone));
  y -= rowH;

  // Linha 2: Razão Social | Município / UF | Código IBGE / CEP
  const nomeTomador = (tomador.nome || '-').toUpperCase();
  const nomeMun = resolverNomeMunicipio(tomador.municipio || prestador.municipio, tomador.municipio || prestador.municipio);
  const munUf = `${nomeMun} / ${(tomador.uf || prestador.uf || 'RS').toUpperCase()}`;
  const cepFmt = formatarCep(tomador.cep);
  const ibgeCep = `${tomador.municipio ? tomador.municipio.replace(/(\d{2})(\d{5})/, '$1.$2') : '43.14902'} / ${cepFmt}`;

  desenharCelula(ctx, ctx.marginX, y, 270, rowH, 'Nome / Nome Empresarial', nomeTomador, true);
  desenharCelula(ctx, ctx.marginX + 270, y, 145, rowH, 'Município / Sigla UF', munUf);
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'Código IBGE / CEP', ibgeCep);
  y -= rowH;

  // Linha 3: Endereço | E-mail
  desenharCelula(ctx, ctx.marginX, y, 415, rowH, 'Endereço', (tomador.endereco || '-').toUpperCase());
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'E-mail', (tomador.email || '-').toLowerCase());
  y -= rowH;

  ctx.currentY = y;
}

export function renderizarBarrasDestinatarioEIntermediario(ctx: ContextoRenderizacaoDanfse): void {
  const h = 11;
  // Barra 1: Destinatário
  desenharCaixa(ctx, ctx.marginX, ctx.currentY - h, ctx.contentWidth, h);
  drawCenteredBarText(ctx, 'DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', ctx.currentY - 8);
  ctx.currentY -= h;

  // Barra 2: Intermediário
  desenharCaixa(ctx, ctx.marginX, ctx.currentY - h, ctx.contentWidth, h);
  drawCenteredBarText(ctx, 'INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', ctx.currentY - 8);
  ctx.currentY -= h;
}

function drawCenteredBarText(ctx: ContextoRenderizacaoDanfse, text: string, y: number): void {
  const size = 6.2;
  const w = ctx.fontBold.widthOfTextAtSize(text, size);
  ctx.page.drawText(text, {
    x: ctx.marginX + (ctx.contentWidth - w) / 2,
    y,
    size,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });
}
