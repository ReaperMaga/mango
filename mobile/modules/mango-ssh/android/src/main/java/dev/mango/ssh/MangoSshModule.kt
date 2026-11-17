package dev.mango.ssh

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android has no SSH transport yet. The module exists so the app loads the same way on
 * both platforms, and every call says plainly that SSH is missing.
 */
class MangoSshModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MangoSsh")

    Events("onLines", "onExit")

    AsyncFunction("importKey") { _: String, _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("generateKey") { _: String, _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("publicKey") { _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("deleteKey") { _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("probeHostKey") { _: String, _: Int, promise: Promise -> unavailable(promise) }
    AsyncFunction("run") { _: Map<String, Any?>, _: String, _: Map<String, Any?>, promise: Promise -> unavailable(promise) }
    AsyncFunction("exec") { _: String, _: Map<String, Any?>, _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("write") { _: String, _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("closeStdin") { _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("kill") { _: String, promise: Promise -> unavailable(promise) }
    AsyncFunction("disconnect") { _: Map<String, Any?>, promise: Promise -> unavailable(promise) }
  }

  private fun unavailable(promise: Promise) {
    promise.reject("ERR_SSH", "SSH is not available on Android yet.", null)
  }
}
