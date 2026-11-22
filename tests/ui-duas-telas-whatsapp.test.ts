import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');

describe('front-end web enxuto de 2 telas primárias (Login/OTP → Conectar WhatsApp → Continue pelo WhatsApp)', () => {
  it('mantém as telas de Login/OTP e Conexão do WhatsApp por Código ou QR Code', () => {
    expect(html).toContain('id="cardAuth"');
    expect(html).toContain('id="formTelefone"');
    expect(html).toContain('id="formOtp"');
    expect(html).toContain('id="step4View"');
    expect(html).toContain('id="btnIniciarWhatsapp"');
    expect(html).toContain('id="btnConectarQr"');
  });

  it('exibe confirmação limpa "Continue pelo WhatsApp" após conectar e oculta abas/painel legado', () => {
    expect(html).toContain('#tabsNavigation, .painel-layout { display: none !important; }');
    expect(html).toContain('id="whatsappConectadoCard"');
    expect(html).toContain('Continue pelo WhatsApp');
    expect(html).toContain('id="btnAbrirWhatsappConectado"');
    expect(html).toContain('id="btnReconectarWhatsappConectado"');
    expect(html).toContain('id="btnSairWhatsappConectado"');
  });
});
