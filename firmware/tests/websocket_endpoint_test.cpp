// Standalone host test of the production resolver. Put runtime_stubs before
// ../xiaozhi-esp32/main on the include path; C++17 and -UNDEBUG are required.
#include "websocket_endpoint_policy.h"
#include <settings.h>
#include "websocket_endpoint.h"
#include <cassert>
#include <string>
#include <vector>

using namespace runtime_safety;

namespace {
void ResetStrings() {
    Settings::persisted_strings.clear();
    Settings::string_writes = 0;
}
void Seed(const std::string& key, const std::string& value) {
    Settings::persisted_strings[{"websocket", key}] = value;
}
std::string Stored(const std::string& key) {
    return Settings("websocket", false).GetString(key);
}
bool HasOverride() {
    return Settings::persisted_strings.count({"websocket", "url_override"}) != 0;
}

void CheckValid(const std::string& url) {
    assert(ValidWebsocketUrl(url));
    assert(!WebsocketScheme(url).empty());
    assert(!WebsocketHost(url).empty());

    // Explicit valid override wins and is never rewritten, including over an
    // invalid legacy value. Paths, query data and encoded spaces are unchanged.
    ResetStrings();
    Seed("url_override", url);
    Seed("url", "wss://legacy-user:secret@bad.example/ws");
    assert(GetEffectiveWebsocketUrl() == url);
    assert(Stored("url_override") == url);
    assert(Settings::string_writes == 0);

    // Missing override migrates a valid legacy endpoint exactly once.
    ResetStrings();
    Seed("url", url);
    assert(!HasOverride());
    assert(GetEffectiveWebsocketUrl() == url);
    assert(Stored("url_override") == url && Stored("url") == url);
    assert(Settings::string_writes == 1);
    assert(GetEffectiveWebsocketUrl() == url);
    assert(Settings::string_writes == 1);

    // An explicitly empty override has the same valid-legacy migration policy.
    ResetStrings();
    Seed("url_override", "");
    Seed("url", url);
    assert(GetEffectiveWebsocketUrl() == url);
    assert(Stored("url_override") == url && Settings::string_writes == 1);
}

void CheckInvalid(const std::string& url) {
    assert(!url.empty());
    assert(!ValidWebsocketUrl(url));
    assert(WebsocketScheme(url).empty());

    // Crucial precedence case: a nonempty invalid override MUST NOT fall back
    // to a valid legacy endpoint, migrate it, or expose invalid URL contents.
    ResetStrings();
    Seed("url_override", url);
    Seed("url", "wss://legacy.example:443/ws?token=legacy-secret");
    const auto effective = GetEffectiveWebsocketUrl();
    assert(effective.empty());
    assert(WebsocketHost(effective).empty() && WebsocketScheme(effective).empty());
    assert(Stored("url_override") == url);
    assert(Stored("url") == "wss://legacy.example:443/ws?token=legacy-secret");
    assert(Settings::string_writes == 0);
    assert(GetEffectiveWebsocketUrl().empty() && Settings::string_writes == 0);

    // Invalid legacy settings are not migrated, even when override is absent.
    ResetStrings();
    Seed("url", url);
    assert(GetEffectiveWebsocketUrl().empty());
    assert(!HasOverride() && Stored("url") == url && Settings::string_writes == 0);

    // An empty override must not make invalid legacy acceptable either.
    ResetStrings();
    Seed("url_override", "");
    Seed("url", url);
    assert(GetEffectiveWebsocketUrl().empty());
    assert(Stored("url_override").empty() && Settings::string_writes == 0);
}
} // namespace

int main() {
    const int original_volume = Settings::persisted_volume;
    const int original_volume_writes = Settings::writes;
    const std::string max_dns = std::string(63, 'a') + "." + std::string(63, 'b') + "." +
                                std::string(63, 'c') + "." + std::string(61, 'd');
    const std::string max_url_prefix = "wss://localhost/";
    const std::string max_url = max_url_prefix + std::string(kMaxWebsocketUrlLength - max_url_prefix.size(), 'a');
    const std::vector<std::string> valid = {
        "ws://localhost", "wss://localhost:1", "ws://localhost:65535/ws", "ws://localhost:00080/",
        "wss://example.com", "wss://EXAMPLE.com.:443/ws", "ws://bridge-name", "ws://a-b.example/ws",
        "ws://127.0.0.1:8080/ws", "ws://0.0.0.0", "ws://255.255.255.255:65535",
        "ws://[::]", "ws://[::1]:8080/ws", "wss://[2001:db8::1]:443/ws?token=secret",
        "ws://[2001:DB8:1:2:3:4:5:6]", "ws://[2001:db8:1:2:3:4:5::]",
        "ws://[1::2:3:4:5:6:7]", "ws://[::ffff:192.0.2.128]",
        "ws://[0:0:0:0:0:ffff:192.0.2.128]:80/", "ws://[::192.0.2.1]/ws",
        "wss://example.com/ws/v1?token=a%20b&next=%2Fprivate%3Fx%3D1",
        "ws://localhost?token=secret", "ws://localhost/?", "ws://localhost/path/@name?email=a@b",
        "ws://localhost/a%2fb/%7Euser?punctuation=!$&'()*+,;=:@/?",
        "ws://localhost/?encoded=%23%5C%25%FF", // Encoded data, not raw delimiters or controls.
        "ws://" + std::string(63, 'a') + ".example/ws", "ws://" + max_dns, "ws://" + max_dns + ".",
        max_url,
    };
    for (const auto& url : valid) CheckValid(url);

    const std::vector<std::string> invalid = {
        "ws://", "wss://", "wss:///ws", "ws://?token=secret", "ws://:80/ws",
        "http://localhost/ws", "https://localhost/ws", "WS://localhost/ws", "Wss://localhost/ws",
        "ws:/localhost", "ws:localhost", "wss://user:secret@example.com/ws",
        "ws://user@example.com", "ws://first@user:secret@[::1]:80/ws",
        "ws://example.com#secret", "ws://example.com/ws?token=secret#fragment",
        "ws://example.com\\private", "ws://example.com/ws?token=a\\b",
        " ws://localhost/ws", "ws://localhost/ws ", "ws://local host/ws",
        "ws://localhost:0", "ws://localhost:65536", "ws://localhost:99999999999999999999999",
        "ws://localhost:", "ws://localhost:-1", "ws://localhost:+80", "ws://localhost:80junk",
        "ws://localhost:80:90", "ws://localhost:00000", "ws://localhost:80.0",
        "ws://-bad.example", "ws://bad-.example", "ws://bad_name.example", "ws://.example",
        "ws://example..com", "ws://example.com..", "ws://.", "ws://%65xample.com",
        "ws://256.1.1.1", "ws://127.1", "ws://1.2.3", "ws://1.2.3.4.5", "ws://01.2.3.4",
        "ws://1.2.3.4.", "ws://[127.0.0.1]", "ws://::1", "ws://2001:db8::1",
        "ws://[]", "ws://[::1", "ws://[::1]junk", "ws://[::1]:", "ws://[::1]:0",
        "ws://[::1]:65536", "ws://[::1]:abc", "ws://[::1]]", "ws://[[::1]]",
        "ws://[fe80::1%25eth0]", "ws://[v1.fe80]", "ws://[2001:db8::g]", "ws://[12345::1]",
        "ws://[1:2:3:4:5:6:7]", "ws://[1:2:3:4:5:6:7:8:9]", "ws://[1:2:3:4:5:6:7:8::]",
        "ws://[::1:2:3:4:5:6:7:8]", "ws://[1::2::3]", "ws://[:::1]", "ws://[1:::2]",
        "ws://[:1:2:3:4:5:6:7]", "ws://[1:2:3:4:5:6:7:]", "ws://[::ffff:256.0.0.1]",
        "ws://[1:2:3:4:5:192.0.2.1]", "ws://[1:2:3:4:5:6:7:192.0.2.1]", "ws://[192.0.2.1::]",
        "ws://localhost/%", "ws://localhost/%0", "ws://localhost/%GG", "ws://localhost/%0g",
        "ws://localhost/%g0", "ws://localhost/%00", "ws://localhost/%0a", "ws://localhost/%0D",
        "ws://localhost/ws?token=%09", "ws://localhost/%1f", "ws://localhost/%7F",
        "ws://localhost/<private>", "ws://localhost/\"secret\"",
        "ws://" + std::string(64, 'a') + ".example/ws", "ws://" + max_dns + "e", max_url + "a",
        std::string("ws://localhost") + '\0' + "/ws?token=secret",
        std::string("ws://localhost/ws?token=") + '\0' + "secret",
    };
    for (const auto& url : invalid) CheckInvalid(url);

    // Every raw ASCII whitespace/control byte is rejected without trimming.
    // Exercise the resolver too, not merely a duplicate test-only selector.
    for (unsigned value = 0; value <= 0x20; ++value) {
        CheckInvalid(std::string("ws://localhost/ws") + static_cast<char>(value) + "?token=secret");
    }
    CheckInvalid(std::string("ws://localhost/ws") + '\x7f');
    // Every percent-decoded C0 control and DEL is likewise rejected.
    constexpr char hex[] = "0123456789ABCDEF";
    for (unsigned value = 0; value <= 0x7f; ++value) {
        if (value >= 0x20 && value != 0x7f) continue;
        std::string url = "ws://localhost/ws?token=%";
        url += hex[value >> 4];
        url += hex[value & 15];
        CheckInvalid(url);
    }

    ResetStrings();
    assert(!ValidWebsocketUrl(""));
    assert(GetEffectiveWebsocketUrl().empty() && !HasOverride() && Settings::string_writes == 0);
    Seed("url_override", "");
    Seed("url", "");
    assert(GetEffectiveWebsocketUrl().empty() && Settings::string_writes == 0);
    Settings::persisted_strings[{"unrelated", "url"}] = "ws://wrong-namespace.example";
    assert(GetEffectiveWebsocketUrl().empty() && Settings::string_writes == 0);

    ResetStrings();
    Seed("url_override", "wss://new.example/ws?token=new-secret");
    Seed("url", "ws://old.example/ws?token=old-secret");
    const auto effective = GetEffectiveWebsocketUrl();
    assert(effective == "wss://new.example/ws?token=new-secret");
    assert(WebsocketHost(effective) == "new.example" && WebsocketScheme(effective) == "wss");
    assert(Settings::string_writes == 0);

    // Redaction intentionally remains safe on arbitrary userinfo-bearing input
    // even though such URLs cannot be selected as runtime endpoints anymore.
    assert(WebsocketHost("wss://user:secret@example.com:443/private?token=secret") == "example.com");
    assert(WebsocketHost("wss://first@user:secret@[2001:db8::1]:443/private?token=secret") == "[2001:db8::1]");
    assert(WebsocketHost("wss://user:secret@[::ffff:192.0.2.1]:443/private") == "[::ffff:192.0.2.1]");
    assert(WebsocketHost("wss://user:secret@[::1/private").empty());
    assert(WebsocketHost("").empty());

    // New string fixtures must not perturb the codec's existing volume stub.
    assert(Settings::persisted_volume == original_volume && Settings::writes == original_volume_writes);
}
