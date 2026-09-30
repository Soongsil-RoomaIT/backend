package kr.ac.roomcare.notification.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Base64;
import org.junit.jupiter.api.Test;

class AesGcmCipherTest {
    @Test
    void encryptsWithRandomIvAndDecrypts() {
        String key = Base64.getEncoder().encodeToString(new byte[32]);
        AesGcmCipher cipher = new AesGcmCipher(key);
        String first = cipher.encrypt("device-token");
        String second = cipher.encrypt("device-token");
        assertThat(first).isNotEqualTo(second);
        assertThat(cipher.decrypt(first)).isEqualTo("device-token");
    }
}

