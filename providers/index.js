'use strict';

/**
 * PROVIDER REGISTRY
 * =================
 * AUDIO_PROVIDER env degiskeni ile saglayici secilir:
 *   suno | replicate | elevenlabs | mock
 *
 * Varsayilan: suno
 *
 * Tum adaptorlar ayni sozlesmeyi uygular (bkz. ./base.js). Route katmani
 * yalnizca bu arayuzu bilir; istemci uygulamasinda degisiklik gerekmez.
 */

const providers = {
  suno: require('./suno'),
  replicate: require('./replicate'),
  elevenlabs: require('./elevenlabs'),
  mock: require('./mock'),
};

let activeName = null;

/** Aktif saglayici adi (env'den, gecersizse suno). */
function getProviderName() {
  if (activeName) return activeName;
  const requested = String(process.env.AUDIO_PROVIDER || 'suno').trim().toLowerCase();
  activeName = providers[requested] ? requested : 'suno';
  return activeName;
}

function setProviderName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!providers[normalized]) return null;
  activeName = normalized;
  return activeName;
}

function getProvider() {
  return providers[getProviderName()];
}

function listProviders() {
  return Object.keys(providers);
}

module.exports = { getProvider, getProviderName, setProviderName, listProviders, providers };
