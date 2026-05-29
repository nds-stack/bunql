/**
 * @module driver/mongodb/auth-scram
 * @description SCRAM-SHA-256 authentication for MongoDB — RFC 5802.
 */

import { base64encode, base64decode, base64decodeToBytes, sha256, hmac, xorBuffers, buffersEqual, generateNonce, escapeUsername, textEncoder } from "./crypto-utils";

export interface SaslStartResponse {
  conversationId: number;
  payload: string;
  ok: number;
  code?: number;
  errmsg?: string;
}

export interface SaslContinueResponse {
  conversationId: number;
  payload: string;
  done: boolean;
  ok: number;
  code?: number;
  errmsg?: string;
}

export async function performScramSha256(
  executeAuth: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>,
  username: string,
  password: string,
): Promise<void> {
  const _authDb = "admin";
  const clientNonce = generateNonce();
  const firstBare = `n=${escapeUsername(username)},r=${clientNonce}`;
  const clientFirst = `n,,${firstBare}`;

  const startResp = await executeAuth({
    saslStart: 1,
    mechanism: "SCRAM-SHA-256",
    payload: base64encode(textEncoder.encode(clientFirst)),
  }) as unknown as SaslStartResponse;

  if (startResp.ok !== 1) {
    throw new ScramError("Failed to start authentication", startResp.code ?? -1);
  }

  const conversationId = startResp.conversationId;
  const payloadStr = base64decode(startResp.payload);

  const parts = payloadStr.split(",");
  const rVal = parts.find((p: string) => p.startsWith("r="));
  const sVal = parts.find((p: string) => p.startsWith("s="));
  const iVal = parts.find((p: string) => p.startsWith("i="));

  if (!rVal || !sVal || !iVal) {
    throw new ScramError("Invalid SCRAM response from server", -1);
  }

  const serverNonce = rVal.substring(2);
  const salt = sVal.substring(2);
  const iterationCount = parseInt(iVal.substring(2), 10);

  if (!serverNonce.startsWith(clientNonce)) {
    throw new ScramError("Server nonce does not match client nonce", -1);
  }

  const withoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${firstBare},${payloadStr},${withoutProof}`;

  const saltedPassword = await hi(password, salt, iterationCount);

  const clientKey = await hmac(saltedPassword, textEncoder.encode("Client Key"));
  const storedKey = await sha256(clientKey);

  const clientSignature = await hmac(storedKey, textEncoder.encode(authMessage));
  const clientProof = xorBuffers(clientKey, clientSignature);

  const serverKey = await hmac(saltedPassword, textEncoder.encode("Server Key"));
  const serverSignature = await hmac(serverKey, textEncoder.encode(authMessage));

  const finalPayload = `${withoutProof},p=${base64encode(clientProof)}`;

  const finalResp = await executeAuth({
    saslContinue: 1,
    conversationId,
    payload: base64encode(textEncoder.encode(finalPayload)),
  }) as unknown as SaslContinueResponse;

  if (finalResp.ok !== 1) {
    throw new ScramError("Authentication failed", finalResp.code ?? -1);
  }

  const finalPayloadStr = base64decode(finalResp.payload);
  const vParts = finalPayloadStr.split(",").filter((p: string) => p.startsWith("v="));
  if (vParts.length > 0) {
    const serverSig = base64decodeToBytes(vParts[0]!.substring(2));
    if (!buffersEqual(serverSig, serverSignature)) {
      throw new ScramError("Server signature verification failed", -1);
    }
  }
}

export class ScramError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "ScramError";
    this.code = code;
  }
}

async function hi(password: string, salt: string, iterations: number): Promise<Uint8Array> {
  const saltBytes = base64decodeToBytes(salt);
  const passwordBytes = textEncoder.encode(password);

  const initialBlock = new Uint8Array(saltBytes.length + 4);
  initialBlock.set(saltBytes);
  initialBlock[saltBytes.length] = 0;
  initialBlock[saltBytes.length + 1] = 0;
  initialBlock[saltBytes.length + 2] = 0;
  initialBlock[saltBytes.length + 3] = 1;

  let u = await hmac(passwordBytes, initialBlock);
  let result = new Uint8Array(u.buffer, u.byteOffset, u.byteLength);

  for (let i = 1; i < iterations; i++) {
    u = await hmac(passwordBytes, u);
    result = xorBuffers(result, u);
  }

  return result;
}

export type { };
