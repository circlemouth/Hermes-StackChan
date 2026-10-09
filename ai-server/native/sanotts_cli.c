#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "saan_pcm.h"
#include "saan_console.h"

void *saan_web_alloc(int nbytes);
int saan_web_init(const void *model, int model_len, const void *dict, int dict_len);
int saan_web_synth(const char *text, int nbytes);
const float *saan_web_pcm(void);
int saan_web_n_samples(void);
const char *saan_web_message(void);
int saan_web_sample_rate(void);

static void usage(const char *program) {
    fprintf(stderr, "Usage: %s --model FILE --dict FILE --output FILE --text TEXT\n", program);
}

static int read_file(const char *path, void **data_out, int *size_out) {
    FILE *file = fopen(path, "rb");
    if (!file) {
        fprintf(stderr, "Cannot open %s: %s\n", path, strerror(errno));
        return -1;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fprintf(stderr, "Cannot seek %s\n", path);
        fclose(file);
        return -1;
    }
    const long size = ftell(file);
    if (size <= 0 || size > INT32_MAX || fseek(file, 0, SEEK_SET) != 0) {
        fprintf(stderr, "Invalid file size for %s\n", path);
        fclose(file);
        return -1;
    }
    void *data = saan_web_alloc((int)size);
    if (!data) {
        fprintf(stderr, "Cannot allocate %ld bytes for %s\n", size, path);
        fclose(file);
        return -1;
    }
    if (fread(data, 1, (size_t)size, file) != (size_t)size) {
        fprintf(stderr, "Cannot read %s\n", path);
        free(data);
        fclose(file);
        return -1;
    }
    fclose(file);
    *data_out = data;
    *size_out = (int)size;
    return 0;
}

static void write_u16_le(FILE *file, uint16_t value) {
    const uint8_t bytes[2] = {(uint8_t)(value & 0xffu), (uint8_t)(value >> 8)};
    fwrite(bytes, 1, sizeof bytes, file);
}

static void write_u32_le(FILE *file, uint32_t value) {
    const uint8_t bytes[4] = {
        (uint8_t)(value & 0xffu),
        (uint8_t)((value >> 8) & 0xffu),
        (uint8_t)((value >> 16) & 0xffu),
        (uint8_t)(value >> 24),
    };
    fwrite(bytes, 1, sizeof bytes, file);
}

static int write_wav(const char *path, const float *pcm, int sample_count, int sample_rate) {
    if (!pcm || sample_count <= 0 || sample_rate <= 0) {
        fprintf(stderr, "sanoTTS-jp returned no audio samples\n");
        return -1;
    }
    const uint64_t data_size_64 = (uint64_t)(uint32_t)sample_count * sizeof(int16_t);
    if (data_size_64 > UINT32_MAX - 36u) {
        fprintf(stderr, "Synthesized audio is too large for WAV\n");
        return -1;
    }
    const uint32_t data_size = (uint32_t)data_size_64;
    FILE *file = fopen(path, "wb");
    if (!file) {
        fprintf(stderr, "Cannot create %s: %s\n", path, strerror(errno));
        return -1;
    }

    fwrite("RIFF", 1, 4, file);
    write_u32_le(file, 36u + data_size);
    fwrite("WAVEfmt ", 1, 8, file);
    write_u32_le(file, 16);
    write_u16_le(file, 1);
    write_u16_le(file, 1);
    write_u32_le(file, (uint32_t)sample_rate);
    write_u32_le(file, (uint32_t)sample_rate * 2u);
    write_u16_le(file, 2);
    write_u16_le(file, 16);
    fwrite("data", 1, 4, file);
    write_u32_le(file, data_size);
    for (int i = 0; i < sample_count; ++i) {
        write_u16_le(file, (uint16_t)saan_f32_to_i16(pcm[i]));
    }

    const int write_failed = ferror(file);
    if (fclose(file) != 0 || write_failed) {
        fprintf(stderr, "Cannot finish %s: %s\n", path, strerror(errno));
        return -1;
    }
    return 0;
}

int main(int argc, char **argv) {
    const char *model_path = NULL;
    const char *dict_path = NULL;
    const char *output_path = NULL;
    const char *text = NULL;
    if (argc % 2 != 1) {
        usage(argv[0]);
        return 2;
    }
    for (int i = 1; i + 1 < argc; i += 2) {
        if (strcmp(argv[i], "--model") == 0) model_path = argv[i + 1];
        else if (strcmp(argv[i], "--dict") == 0) dict_path = argv[i + 1];
        else if (strcmp(argv[i], "--output") == 0) output_path = argv[i + 1];
        else if (strcmp(argv[i], "--text") == 0) text = argv[i + 1];
        else {
            usage(argv[0]);
            return 2;
        }
    }
    if (!model_path || !dict_path || !output_path || !text) {
        usage(argv[0]);
        return 2;
    }

    const size_t text_size = strlen(text);
    if (text_size == 0 || text_size > SAAN_CONSOLE_LINE_MAX) {
        fprintf(stderr, "sanoTTS-jp text must be 1..%d UTF-8 bytes\n", SAAN_CONSOLE_LINE_MAX);
        return 2;
    }

    void *model = NULL;
    void *dict = NULL;
    int model_size = 0;
    int dict_size = 0;
    if (read_file(model_path, &model, &model_size) != 0 ||
        read_file(dict_path, &dict, &dict_size) != 0) {
        free(model);
        free(dict);
        return 1;
    }

    int rc = saan_web_init(model, model_size, dict, dict_size);
    if (rc == 0) rc = saan_web_synth(text, (int)strlen(text));
    if (rc != 0) {
        /* Upstream diagnostics may quote rejected input; never log speech. */
        fprintf(stderr, "sanoTTS-jp failed (%d)\n", rc);
        free(model);
        free(dict);
        return 1;
    }
    const char *message = saan_web_message();
    if (message && message[0] != '\0') fprintf(stderr, "sanoTTS-jp synthesized with warnings\n");

    rc = write_wav(output_path, saan_web_pcm(), saan_web_n_samples(), saan_web_sample_rate());
    free(model);
    free(dict);
    return rc == 0 ? 0 : 1;
}
