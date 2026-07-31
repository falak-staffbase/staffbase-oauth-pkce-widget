import '@testing-library/jest-dom'
import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'

/**
 * jsdom does not expose the global text encoding classes that PKCE uses to hash the
 * verifier.
 */
if (!globalThis.TextEncoder) {
  Object.assign(globalThis, { TextEncoder, TextDecoder })
}

/**
 * jsdom ships `crypto.getRandomValues` but not `crypto.subtle`, which PKCE needs for
 * the S256 challenge. Node's WebCrypto implements the same standard interface.
 */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
