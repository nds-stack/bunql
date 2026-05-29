import { PGError } from "./error";
import { concat } from "./helpers";
import { PGReader, encodePassword, encodeMD5Password, type PGMessage } from "./wire";

export async function performAuth(
  readBuffer: () => Promise<Uint8Array>,
  write: (data: Uint8Array) => void,
  user: string,
  password?: string,
): Promise<void> {
  let reader = new PGReader(new Uint8Array(0));

  for (let attempts = 0; attempts < 100; attempts++) {
    const raw = await readBuffer();
    const combined = concat([reader.buffer.subarray(reader.offset), raw]);
    const newReader = new PGReader(combined);

    while (newReader.hasMessage()) {
      const msg = newReader.readMessage()!;
      switch (msg.type) {
        case "AuthenticationOk":
          return;
        case "AuthenticationCleartextPassword": {
          if (!password) throw new PGError("Password required");
          write(encodePassword(password));
          continue;
        }
        case "AuthenticationMD5Password": {
          if (!password) throw new PGError("Password required");
          write(encodeMD5Password(password, user, msg.salt));
          continue;
        }
        case "ErrorResponse":
          throw new PGError(`Auth failed: ${msg.message}`);
        case "ReadyForQuery":
          return;
        default:
          continue;
      }
    }

    if (newReader.available > 0) {
      const buf = new PGReader(new Uint8Array(newReader.buffer.subarray(newReader.offset)));
      Object.assign(reader, buf);
    }
  }
  throw new PGError("Auth timeout");
}
