//! Tenant-held crypto. The key never crosses into script globals or env.
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, Rng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CryptoDomains {
    pub hmac: String,
    pub seal: String,
}

impl Default for CryptoDomains {
    fn default() -> Self {
        Self {
            hmac: "softn:hmac:v1".into(),
            seal: "softn:seal:v1".into(),
        }
    }
}

#[derive(Clone)]
pub struct NativeCrypto {
    hmac_key: [u8; 32],
    encryption_key: [u8; 32],
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn keyed(key: &[u8], text: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(text);
    mac.finalize().into_bytes().into()
}

impl NativeCrypto {
    pub fn from_hex(key: &str, domains: &CryptoDomains) -> Result<Self, String> {
        if [&domains.hmac, &domains.seal].iter().any(|domain| {
            domain.is_empty() || domain.len() > 128 || !domain.bytes().all(|b| b.is_ascii_graphic())
        }) || domains.hmac == domains.seal
        {
            return Err(
                "Crypto domains must be distinct printable ASCII strings of 1-128 bytes".into(),
            );
        }
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(
                "backend.json keyHex must contain 32 random bytes encoded as 64 hex characters"
                    .into(),
            );
        }
        let bytes: Vec<u8> = (0..64)
            .step_by(2)
            .map(|i| u8::from_str_radix(&key[i..i + 2], 16).unwrap())
            .collect();
        Ok(Self {
            hmac_key: keyed(&bytes, domains.hmac.as_bytes()),
            encryption_key: keyed(&bytes, domains.seal.as_bytes()),
        })
    }

    pub fn dispatch(&self, kind: &str, a: &str, b: &str) -> Result<serde_json::Value, String> {
        if a.len() > 2 * 1024 * 1024 || b.len() > 2 * 1024 * 1024 {
            return Err("Crypto input exceeds host limit".into());
        }
        Ok(match kind {
            "crypto.sha256" => hex(&Sha256::digest(a.as_bytes())).into(),
            "crypto.hmac" => hex(&keyed(&self.hmac_key, a.as_bytes())).into(),
            "crypto.equal" => {
                (a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))).into()
            }
            "crypto.randomHex" => {
                let n: usize = a.parse().map_err(|_| "Invalid random byte count")?;
                if !(1..=64).contains(&n) {
                    return Err("Random byte count must be 1-64".into());
                }
                let mut bytes = vec![0; n];
                OsRng
                    .try_fill_bytes(&mut bytes)
                    .map_err(|_| "OS random source unavailable")?;
                hex(&bytes).into()
            }
            "crypto.randomInt" => {
                let n: u64 = a.parse().map_err(|_| "Invalid random integer bound")?;
                if n == 0 || n > 9_007_199_254_740_991 {
                    return Err("Invalid random integer bound".into());
                }
                OsRng.gen_range(0..n).into()
            }
            "crypto.seal" => {
                let mut nonce = [0u8; 12];
                OsRng
                    .try_fill_bytes(&mut nonce)
                    .map_err(|_| "OS random source unavailable")?;
                let cipher = Aes256Gcm::new_from_slice(&self.encryption_key)
                    .map_err(|_| "Invalid encryption key")?;
                let sealed = cipher
                    .encrypt(Nonce::from_slice(&nonce), a.as_bytes())
                    .map_err(|_| "Encryption failed")?;
                // Node reference wire contract: nonce | tag | ciphertext, base64.
                let tag_at = sealed.len() - 16;
                let mut envelope = nonce.to_vec();
                envelope.extend_from_slice(&sealed[tag_at..]);
                envelope.extend_from_slice(&sealed[..tag_at]);
                STANDARD.encode(envelope).into()
            }
            _ => return Err("Unknown crypto operation".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_random_and_authenticated_node_envelope() {
        let crypto = NativeCrypto::from_hex(&"11".repeat(32), &CryptoDomains::default()).unwrap();
        assert_eq!(
            crypto.dispatch("crypto.sha256", "abc", "").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            crypto.dispatch("crypto.equal", "abc", "abd").unwrap(),
            false
        );
        assert!(crypto.dispatch("crypto.randomInt", "0", "").is_err());
        let value = crypto.dispatch("crypto.seal", "private OTP", "").unwrap();
        let bytes = STANDARD.decode(value.as_str().unwrap()).unwrap();
        let mut ciphertext = bytes[28..].to_vec();
        ciphertext.extend_from_slice(&bytes[12..28]);
        let cipher = Aes256Gcm::new_from_slice(&crypto.encryption_key).unwrap();
        assert_eq!(
            cipher
                .decrypt(Nonce::from_slice(&bytes[..12]), ciphertext.as_slice())
                .unwrap(),
            b"private OTP"
        );
        ciphertext[0] ^= 1;
        assert!(cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), ciphertext.as_slice())
            .is_err());
    }

    #[test]
    fn operator_domains_are_validated_and_separate_keys() {
        let key = "11".repeat(32);
        let domains = CryptoDomains {
            hmac: "example:sign:v1".into(),
            seal: "example:jobs:v1".into(),
        };
        let custom = NativeCrypto::from_hex(&key, &domains).unwrap();
        let default = NativeCrypto::from_hex(&key, &CryptoDomains::default()).unwrap();
        assert_eq!(custom.hmac_key, keyed(&[0x11; 32], b"example:sign:v1"));
        assert_eq!(
            custom.encryption_key,
            keyed(&[0x11; 32], b"example:jobs:v1")
        );
        assert_ne!(custom.hmac_key, default.hmac_key);
        assert_ne!(custom.encryption_key, default.encryption_key);
        for hmac in [
            "".into(),
            "contains space".into(),
            "x".repeat(129),
            domains.seal.clone(),
        ] {
            assert!(NativeCrypto::from_hex(
                &key,
                &CryptoDomains {
                    hmac,
                    seal: domains.seal.clone()
                }
            )
            .is_err());
        }
    }
}
