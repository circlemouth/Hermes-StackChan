#pragma once

#include <cstddef>
#include <cstring>
#include <initializer_list>
#include <string>

class AppLauncher;
class AppSetup;

namespace diagnostics {
constexpr unsigned kProtocolVersion = 1;
constexpr size_t kMaxLine = 128;
enum class Command { None, Status, Reboot, OpenSetup, OpenHermes, SdPrompt, SdRead, ListenStart, ListenStop, Unknown, Overflow, Invalid };

inline const char* commandName(Command command)
{
    switch (command) {
    case Command::Status: return "status";
    case Command::Reboot: return "reboot-to-launcher";
    case Command::OpenSetup: return "open setup";
    case Command::OpenHermes: return "open hermes";
    case Command::SdPrompt: return "sd prompt";
    case Command::SdRead: return "sd read";
    case Command::ListenStart: return "listen start";
    case Command::ListenStop: return "listen stop";
    default: return "unknown"; // Never echo untrusted input.
    }
}

// Pure, fail-closed policy shared by USB acceptance and app_main execution.
// Ownership changes before runtime initialization; it is not readiness by itself.
inline const char* listenRefusal(bool runtime, const char* device_state)
{
    if (!runtime) return "requires_hermes";
    for (const char* ready : {"idle", "connecting", "listening", "speaking"}) {
        if (device_state && std::strcmp(device_state, ready) == 0) return nullptr;
    }
    return "runtime_not_ready";
}

// No allocation, echo, shell, escaping or arbitrary argument handling.
class LineParser {
public:
    Command push(unsigned char byte)
    {
        if (byte == '\r' || byte == '\n') {
            if (!_size && !_overflow) return Command::None;
            Command result = Command::None;
            const bool marked = _size >= 8 && std::memcmp(_line, "SC_DIAG ", 8) == 0;
            if (marked) {
                if (_overflow) result = Command::Overflow;
                else if (_invalid) result = Command::Invalid;
                else {
                    _line[_size] = '\0';
                    result = Command::Unknown;
                    for (Command candidate : {Command::Status, Command::Reboot, Command::OpenSetup,
                                              Command::OpenHermes, Command::SdPrompt, Command::SdRead,
                                              Command::ListenStart, Command::ListenStop}) {
                        if (std::strcmp(_line + 8, commandName(candidate)) == 0) {
                            result = candidate;
                            break;
                        }
                    }
                }
            }
            _size = 0;
            _overflow = _invalid = false;
            return result;
        }
        if (_size < kMaxLine) _line[_size++] = static_cast<char>(byte);
        else _overflow = true; // Discard until newline, never execute a suffix.
        if (byte < 32 || byte > 126) _invalid = true;
        return Command::None;
    }
private:
    char _line[kMaxLine + 1]{};
    size_t _size = 0;
    bool _overflow = false;
    bool _invalid = false;
};

struct Endpoint { std::string scheme; std::string host; };
inline Endpoint redactedEndpoint(const std::string& url)
{
    Endpoint result;
    auto sep = url.find("://");
    if (sep == std::string::npos) return result;
    const auto scheme = url.substr(0, sep);
    if (scheme != "ws" && scheme != "wss") return result;
    const auto start = sep + 3;
    const auto end = url.find_first_of("/?#", start);
    auto authority = url.substr(start, end == std::string::npos ? end : end - start);
    const auto at = authority.rfind('@');
    if (at != std::string::npos) authority.erase(0, at + 1);
    std::string host;
    bool ipv6 = !authority.empty() && authority.front() == '[';
    if (ipv6) {
        auto close = authority.find(']');
        if (close == std::string::npos) return result;
        host = authority.substr(1, close - 1);
        if (close + 1 < authority.size() && authority[close + 1] != ':') return result;
    } else {
        host = authority.substr(0, authority.find(':'));
    }
    if (host.empty() || host.size() > 128) return result;
    for (unsigned char c : host) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '.' || c == '-' || (ipv6 && c == ':'))) return result;
    }
    result.scheme = scheme;
    result.host = host;
    return result;
}

// Call after installing apps, from app_main. Returns false on disabled USB/allocation failure.
bool init(AppLauncher* launcher, AppSetup* setup);
// Call once per Launcher mainloop iteration, outside the LVGL lock. At most one action/frame.
void process();
// Call before Mooncake teardown. Thereafter USB task serves status/reboot and
// schedules runtime-ready listen controls on app_main, never touches borrowed UI.
void markHermesHandoff();
} // namespace diagnostics
