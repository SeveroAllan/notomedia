import { expect, it } from 'vitest';
import { origemWebhookConfigurada } from '../src/onboarding/io/origem-webhook.js';
it.each(['https://notomed.tech','https://notomed.tech/'])('usa somente origem HTTPS configurada %s', valor => {
  expect(origemWebhookConfigurada(valor)).toBe('https://notomed.tech');
});
it.each([undefined,'','http://notomed.tech','https://user:senha@notomed.tech','https://notomed.tech/path','https://notomed.tech/?x=1','https://notomed.tech/#a','invalido'])('recusa origem ausente/inválida sem fallback %s', valor => {
  expect(origemWebhookConfigurada(valor)).toBeNull();
});
