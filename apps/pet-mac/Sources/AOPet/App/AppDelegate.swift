import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let manager = WindowManager()
    private var poller: SessionPoller?
    private var listener: SocketListener?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let manager = self.manager

        let poller = SessionPoller { response in
            let names = response.projectNames()
            let projects = StateAggregator.aggregate(
                sessions: response.sessions,
                projectNames: names
            )
            manager.reconcile(with: projects)
        }
        poller.start()
        self.poller = poller

        let listener = SocketListener { envelope in
            manager.deliver(event: envelope)
        }
        listener.start()
        self.listener = listener
    }

    func applicationWillTerminate(_ notification: Notification) {
        poller?.stop()
        listener?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}
