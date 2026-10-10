#pragma once
#include <string>
#include <map>
#include <utility>
struct Settings {
    inline static int persisted_volume = 70;
    inline static int writes = 0;
    inline static std::map<std::pair<std::string, std::string>, std::string> persisted_strings;
    inline static int string_writes = 0;
    std::string string_namespace;
    bool string_read_write;
    Settings(const std::string& ns, bool read_write) : string_namespace(ns), string_read_write(read_write) {}
    std::string GetString(const std::string& key, const std::string& fallback = "") {
        const auto found = persisted_strings.find({string_namespace, key});
        return found == persisted_strings.end() ? fallback : found->second;
    }
    void SetString(const std::string& key, const std::string& value) {
        if (!string_read_write) return;
        persisted_strings[{string_namespace, key}] = value;
        ++string_writes;
    }
    int GetInt(const std::string&, int) { return persisted_volume; }
    void SetInt(const std::string&, int value) { persisted_volume=value; ++writes; }
};
