#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <dispatch/dispatch.h>
#include <stdbool.h>

// Values shared with permissions.rs: granted, denied, restricted, unknown,
// unavailable. These functions never open an audio stream or save audio.
int lore_microphone_permission(void) {
    @autoreleasepool {
        if (@available(macOS 10.14, *)) {
            switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
                case AVAuthorizationStatusAuthorized: return 0;
                case AVAuthorizationStatusDenied: return 1;
                case AVAuthorizationStatusRestricted: return 2;
                case AVAuthorizationStatusNotDetermined: return 3;
            }
        }
        return 4;
    }
}

void lore_request_microphone_permission(void) {
    @autoreleasepool {
        if (@available(macOS 10.14, *)) {
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                                    completionHandler:^(BOOL granted) { (void)granted; }];
        }
    }
}

// Core Audio taps have no public permission preflight API. Resolve the system's
// status/request entry points at runtime (as in AudioCap), and report unavailable
// if they change. Never use ScreenCapture permission as a substitute or read TCC.db.
typedef int (*LorePreflight)(CFStringRef, CFDictionaryRef);
typedef void (*LoreRequest)(CFStringRef, CFDictionaryRef, void (^)(bool));

static void *lore_tcc(void) {
    static void *handle;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW | RTLD_LOCAL);
    });
    return handle;
}

int lore_system_audio_permission(void) {
    @autoreleasepool {
        void *handle = lore_tcc();
        LorePreflight preflight = handle ? (LorePreflight)dlsym(handle, "TCCAccessPreflight") : NULL;
        if (!preflight) return 4;
        int result = preflight(CFSTR("kTCCServiceAudioCapture"), NULL);
        if (result == 0) return 0;
        if (result == 1) return 1;
        return 3;
    }
}

bool lore_request_system_audio_permission(void) {
    @autoreleasepool {
        void *handle = lore_tcc();
        LoreRequest request = handle ? (LoreRequest)dlsym(handle, "TCCAccessRequest") : NULL;
        if (!request) return false;
        request(CFSTR("kTCCServiceAudioCapture"), NULL, ^(bool granted) { (void)granted; });
        return true;
    }
}
