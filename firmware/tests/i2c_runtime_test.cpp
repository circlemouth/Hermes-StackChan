#include "i2c_device.h"
#include <freertos/task.h>
#include <algorithm>
#include <cassert>
thread_local TaskHandle_t fake_task=reinterpret_cast<void*>(1);
int failures=0, reads=0, writes=0, last_timeout=0;
int i2c_master_bus_add_device(void*,const i2c_device_config_t*,void** dev) { *dev=reinterpret_cast<void*>(1); return ESP_OK; }
int i2c_master_transmit(void*,const uint8_t*,size_t,int timeout) { ++writes; last_timeout=timeout; if (failures) { --failures; return ESP_FAIL; } return ESP_OK; }
int i2c_master_transmit_receive(void*,const uint8_t*,size_t,uint8_t* dest,size_t length,int timeout) { ++reads; last_timeout=timeout; std::fill_n(dest,length,0xff); if (failures) { --failures; return ESP_FAIL; } return ESP_OK; }
struct Device : I2cDevice {
    Device():I2cDevice(nullptr,0x20) {}
    using I2cDevice::ReadReg; using I2cDevice::WriteReg; using I2cDevice::TryReadRegs;
};
int main() {
    Device device;
    uint8_t bytes[4]={1,2,3,4};
    failures=2; assert(device.TryReadRegs(0,bytes,4)==ESP_FAIL);
    assert(reads==2 && device.failure_count()==1);
    assert(std::all_of(bytes,bytes+4,[](auto v){return !v;}));
    device.WriteReg(0,1); assert(writes==0);
    // Another task cannot reopen this task's failed RMW authorization.
    fake_task=reinterpret_cast<void*>(2); assert(device.ReadReg(0)==0xff);
    fake_task=reinterpret_cast<void*>(1); device.WriteReg(0,1); assert(writes==0);
    assert(device.ReadReg(0)==0xff); device.WriteReg(0,1); assert(writes==1 && last_timeout==10);
    failures=1; assert(device.TryReadRegs(0,bytes,4,-1)==ESP_OK); assert(last_timeout==1);
    assert(device.TryReadRegs(0,bytes,4,100000)==ESP_OK); assert(last_timeout==1000);
    failures=2; const int before=writes; device.WriteReg(0,1); assert(writes==before+2 && device.failure_count()==2);
    failures=2; assert(device.ReadReg(0)==0); device.WriteReg(0,1); assert(writes==before+2);
    assert(device.ReadReg(0)==0xff); device.WriteReg(0,1); assert(writes==before+3);
}
