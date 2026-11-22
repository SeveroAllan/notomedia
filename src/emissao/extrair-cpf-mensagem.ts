/**
 * Regras puras para extrair, validar (módulo 11) e mascarar CPF recebido em
 * mensagens naturais de pacientes ou médicos no WhatsApp.
 * Sem dependências de banco ou rede para permanecer testável isoladamente.
 */

import { validarCpf } from '../paciente/validar-cpf.js';

const PADRAO_CPF_CANDIDATO = /(?<!\d)(?:\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s/-]?\d{2})(?!\d)/g;

export function extrairCpfValidoDaMensagem(texto: string): string | null {
  if (!texto?.trim()) return null;
  for (const match of texto.matchAll(PADRAO_CPF_CANDIDATO)) {
    const digitos = match[0].replace(/\D/g, '');
    if (digitos.length === 11 && validarCpf(digitos)) {
      return digitos;
    }
  }
  return null;
}

export function mascararCpfParaChat(cpfLimpo: string | null | undefined): string {
  const d = (cpfLimpo ?? '').replace(/\D/g, '');
  if (d.length !== 11) return 'não informado';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

export function formatarValorReais(centavos: number | null | undefined): string {
  if (typeof centavos !== 'number' || !Number.isFinite(centavos) || centavos <= 0) {
    return 'valor a confirmar';
  }
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
