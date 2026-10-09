#include "diagnostics.h"
#include <cassert>
#include <string>
using namespace diagnostics;

static Command line(LineParser& parser, const std::string& input)
{
    Command result = Command::None;
    for (unsigned char c : input) {
        Command next = parser.push(c);
        if (next != Command::None) result = next;
    }
    return result;
}
int main()
{
    LineParser parser;
    for (Command command : {Command::Status, Command::Reboot, Command::OpenSetup, Command::OpenHermes, Command::SdPrompt, Command::SdRead})
        assert(line(parser, std::string("SC_DIAG ") + commandName(command) + "\r\n") == command);
    assert(line(parser, "status\n") == Command::None);
    assert(line(parser, "prefix SC_DIAG reboot-to-launcher\n") == Command::None);
    assert(line(parser, "SC_DIAG status extra\n") == Command::Unknown);
    assert(line(parser, "SC_DIAG status;reboot-to-launcher\n") == Command::Unknown);
    assert(line(parser, std::string("SC_DIAG status\0", 15) + "\n") == Command::Invalid);
    assert(line(parser, "SC_DIAG " + std::string(120, 'a') + "\n") == Command::Unknown); // Exactly128.
    assert(line(parser, "SC_DIAG " + std::string(121, 'a') + "\n") == Command::Overflow);
    assert(line(parser, "SC_DIAG " + std::string(300, 'a') + "SC_DIAG reboot-to-launcher\n") == Command::Overflow);
    assert(line(parser, "SC_DIAG status\n") == Command::Status); // Recovery only at newline.
    auto endpoint = redactedEndpoint("wss://user:secret@example.invalid:443/private?token=secret#secret");
    assert(endpoint.scheme == "wss" && endpoint.host == "example.invalid");
    endpoint = redactedEndpoint("ws://user:secret@[2001:db8::1]:8765/private");
    assert(endpoint.scheme == "ws" && endpoint.host == "2001:db8::1");
    for (const auto& url : {"https://example.invalid/secret", "ws://bad%40secret/", "ws://[missing", "ws://host\nsecret/", "not-a-url", "ws://user:secret@/"})
        assert(redactedEndpoint(url).host.empty());
}
