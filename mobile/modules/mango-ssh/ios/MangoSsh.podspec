# The SSH transport (SwiftNIO SSH over Network.framework). The NIO packages come from Swift
# Package Manager through React Native's `spm_dependency` (react_native_pods.rb, loaded by the
# Podfile `expo prebuild` writes), which adds them to this pod's target at `pod install`.
# The pod name must stay equal to its Swift module name: React Native rebuilds module map
# paths from the pod name when it links Swift packages into a static library pod.
Pod::Spec.new do |s|
  s.name           = 'MangoSsh'
  s.version        = '0.1.0'
  s.summary        = 'SSH for Mango: Ed25519 keys in the Keychain, pinned host keys, exec channels.'
  s.description    = s.summary
  s.license        = { type: 'Proprietary', text: 'Part of Mango.' }
  s.author         = 'Mango'
  s.homepage       = 'https://github.com/ReaperMaga/mango'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = '**/*.swift'

  unless defined?(spm_dependency)
    raise 'MangoSsh needs React Native\'s spm_dependency (React Native 0.75 or later, loaded by the Podfile).'
  end

  # Versions are the ones the transport was built and tested against; NIO SSH is pre-1.0,
  # so it only takes patch releases.
  spm_dependency(s,
    url: 'https://github.com/apple/swift-nio-ssh.git',
    requirement: { kind: 'upToNextMinorVersion', minimumVersion: '0.15.1' },
    products: ['NIOSSH'])
  spm_dependency(s,
    url: 'https://github.com/apple/swift-nio.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '2.105.0' },
    products: ['NIOCore', 'NIOConcurrencyHelpers'])
  spm_dependency(s,
    url: 'https://github.com/apple/swift-nio-transport-services.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '1.28.0' },
    products: ['NIOTransportServices'])
end
