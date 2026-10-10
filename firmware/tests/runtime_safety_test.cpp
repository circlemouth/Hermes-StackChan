#include "runtime_safety.h"
#include <cassert>
#include <thread>
#include <vector>
using namespace runtime_safety;
struct Owner { bool available=false; int locks=0,unlocks=0; bool Lock(int timeout) { assert(timeout==250); ++locks; return available; } void Unlock() { ++unlocks; } };
int main() {
    Owner owner;
    { OwnedLock<Owner> lock(&owner,250); assert(!lock); } assert(!owner.unlocks);
    owner.available=true;
    { OwnedLock<Owner> lock(&owner,250); assert(lock); lock.Release(); lock.Release(); } assert(owner.unlocks==1);
    { OwnedLock<Owner> lock(nullptr,250); assert(!lock); }
    assert(ValidCredential(" ssid ") && ValidCredential(" password "));
    assert(!ValidCredential("line\n") && !ValidCredential(std::string("a\0b",3)) && !ValidCredential("\x7f"));
    assert(ContainsJsonNul(R"({"password":"a\u0000b"})"));
    assert(!ContainsJsonNul(R"({"password":"a\\u0000b"})"));
    assert(ContainsJsonNul(std::string("a\0b",3)));
    assert(WebsocketHost("wss://user:secret@example.com:443/private?token=secret")=="example.com");
    assert(WebsocketHost("wss://user:secret@[::1]:443/private")=="[::1]");
    assert(SelectWebsocketUrl("wss://new.example/ws","ws://old.example/ws")=="wss://new.example/ws");
    assert(SelectWebsocketUrl("","ws://old.example/ws")=="ws://old.example/ws");
    assert(SelectWebsocketUrl("wss://user:secret@bad.example","ws://old.example/ws").empty());
    assert(SelectWebsocketUrl("","ws://").empty());
    assert(WebsocketHost("wss://first@user:secret@[2001:db8::1]:443/private?token=secret")=="[2001:db8::1]");
    assert(WebsocketScheme("wss://localhost:443/ws?token=secret")=="wss");
    assert(WebsocketScheme("secret://invalid").empty());
    assert(ValidCameraBuffer(1,2,320*240*2,320*240*2,320*240*2));
    assert(!ValidCameraBuffer(2,2,2,2,2)); assert(!ValidCameraBuffer(0,1,0,2,0));
    assert(!ValidCameraBuffer(0,1,1,2,2)); assert(!ValidCameraBuffer(0,1,3,2,0));
    assert(!ValidCameraBuffer(0,1,3*1024*1024,3*1024*1024,0));
    std::vector<uint8_t> png(33); const uint8_t sig[]={0x89,'P','N','G','\r','\n',0x1a,'\n'};
    std::copy(sig,sig+8,png.begin()); png[11]=13; png[12]='I'; png[13]='H'; png[14]='D'; png[15]='R'; png[18]=1; png[19]=64; png[23]=240;
    size_t width,height;
    assert(PreviewDimensions(png.data(),png.size(),width,height) && width==320 && height==240);
    assert(!PreviewDimensions(png.data(),24,width,height));
    png[4]=0; assert(!PreviewDimensions(png.data(),png.size(),width,height)); png[4]='\r';
    png[11]=12; assert(!PreviewDimensions(png.data(),png.size(),width,height)); png[11]=13;
    png[19]=65; assert(!PreviewDimensions(png.data(),png.size(),width,height));
    const uint8_t jpeg[]={0xff,0xd8,0xff,0xc0,0,8,8,0,240,1,64,3};
    assert(PreviewDimensions(jpeg,sizeof(jpeg),width,height) && width==320 && height==240);
    assert(!PreviewDimensions(jpeg,8,width,height)); assert(!PreviewDimensions(nullptr,100,width,height));
    BinaryAudioView frame;
    std::vector<uint8_t> audio(18,0); audio[1]=2; audio[11]=42; audio[15]=2; audio[16]=9; audio[17]=8;
    auto audio_data=reinterpret_cast<const char*>(audio.data());
    assert(ParseBinaryAudio(audio_data,audio.size(),2,frame) && frame.size==2 && frame.timestamp==42 && frame.payload[0]==9);
    for (size_t len=0;len<18;++len) assert(!ParseBinaryAudio(audio_data,len,2,frame));
    audio[12]=0xff; assert(!ParseBinaryAudio(audio_data,audio.size(),2,frame)); audio[12]=0;
    audio[3]=1; assert(!ParseBinaryAudio(audio_data,audio.size(),2,frame)); audio[3]=0;
    const char v3[]={0,0,0,2,9,8};
    assert(ParseBinaryAudio(v3,sizeof(v3),3,frame) && frame.size==2);
    assert(!ParseBinaryAudio(v3,sizeof(v3)-1,3,frame)); assert(!ParseBinaryAudio(nullptr,18,2,frame));
    assert(ParseBinaryAudio(v3,2,1,frame) && frame.size==2);
    assert(!ParseBinaryAudio(v3,16385,1,frame));
    WorkToken token{3,100}; assert(token.live(3,99)); assert(!token.live(3,100)); assert(!token.live(4,1));
    TtsAdmission gate;
    const auto first=gate.Begin(); assert(!gate.accepts()); assert(gate.Admit(first)); assert(gate.accepts());
    gate.Stop(); assert(!gate.accepts() && gate.generation()==first);
    const auto stopped=gate.Begin(); assert(gate.Stop()==stopped); assert(!gate.Admit(stopped) && !gate.accepts());
    const auto cancelled=gate.Begin(); gate.Cancel(); assert(!gate.Admit(cancelled) && !gate.accepts());
    // Race the actual atomic transition: a cancelled turn can never resurrect.
    for (int i=0;i<1000;++i) {
        const auto gen=gate.Begin();
        std::thread cancel([&]{gate.Cancel();});
        gate.Admit(gen); cancel.join(); assert(!gate.accepts()); assert(!gate.Admit(gen));
    }
    FailedReadGate failures;
    failures.fail(1); failures.recover(2); assert(!failures.may_write(1));
    failures.recover(1); assert(failures.may_write(1));
    for (uintptr_t task=1;task<=17;++task) failures.fail(task);
    failures.recover(1); assert(!failures.may_write(1) && !failures.may_write(100));
}
