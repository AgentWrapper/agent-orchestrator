import AppKit
import Foundation
import UserNotifications

let appName = "AO Notifier"
let appVersion = "0.6.0"
let bundleId = "com.aoagents.notifier"

struct NotifyPayload: Codable {
  struct Event: Codable {
    let id: String
    let type: String
    let priority: String
    let sessionId: String
    let projectId: String
    let timestamp: String
  }

  struct Action: Codable {
    let label: String
    let url: String?
    let callbackEndpoint: String?
  }

  let title: String
  let subtitle: String?
  let body: String
  let sound: Bool
  let notificationId: String?
  let threadId: String?
  let defaultOpenUrl: String?
  let event: Event
  let actions: [Action]?
}

final class NotificationResponseDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let actionIdentifier = response.actionIdentifier

    if actionIdentifier == UNNotificationDefaultActionIdentifier {
      if let defaultOpenUrl = userInfo["defaultOpenUrl"] as? String {
        openUrl(defaultOpenUrl)
        completionHandler()
        return
      }
      if let actionUrls = userInfo["actionUrls"] as? [String: String],
        let fallbackUrl = actionUrls.sorted(by: { $0.key < $1.key }).first?.value
      {
        openUrl(fallbackUrl)
      }
      completionHandler()
      return
    }

    if let actionCallbacks = userInfo["actionCallbacks"] as? [String: String],
      let callbackEndpoint = actionCallbacks[actionIdentifier]
    {
      postCallback(callbackEndpoint)
      completionHandler()
      return
    }

    if let actionUrls = userInfo["actionUrls"] as? [String: String],
      let url = actionUrls[actionIdentifier]
    {
      openUrl(url)
    }

    completionHandler()
  }
}

let delegate = NotificationResponseDelegate()

func jsonEscape(_ value: String) -> String {
  let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
  let encoded = String(data: data ?? Data("[]".utf8), encoding: .utf8) ?? "[\"\"]"
  return String(encoded.dropFirst().dropLast())
}

func printJson(_ pairs: [(String, String)]) {
  let body = pairs.map { key, value in
    "\"\(key)\":\(jsonEscape(value))"
  }.joined(separator: ",")
  print("{\(body)}")
}

func printJsonObject(_ value: Any) {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted]),
    let json = String(data: data, encoding: .utf8)
  else {
    print("{}")
    return
  }
  print(json)
}

func openUrl(_ rawUrl: String?) {
  guard let rawUrl = rawUrl, let url = URL(string: rawUrl) else { return }
  NSWorkspace.shared.open(url)
}

func postCallback(_ rawUrl: String?) {
  guard let rawUrl = rawUrl, let url = URL(string: rawUrl) else { return }
  guard url.scheme == "http" || url.scheme == "https" else { return }

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = Data("{\"source\":\"ao-notifier\"}".utf8)

  let semaphore = DispatchSemaphore(value: 0)
  let task = URLSession.shared.dataTask(with: request) { _, _, _ in
    semaphore.signal()
  }
  task.resume()
  _ = semaphore.wait(timeout: .now() + 10)
}

func waitForSettings(_ center: UNUserNotificationCenter) -> UNNotificationSettings? {
  let semaphore = DispatchSemaphore(value: 0)
  var resolved: UNNotificationSettings?
  center.getNotificationSettings { settings in
    resolved = settings
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + 5)
  return resolved
}

func notificationSettingStatus(_ setting: UNNotificationSetting) -> String {
  switch setting {
  case .enabled:
    return "enabled"
  case .disabled:
    return "disabled"
  case .notSupported:
    return "not_supported"
  @unknown default:
    return "unknown"
  }
}

func permissionStatus() -> String {
  guard let settings = waitForSettings(UNUserNotificationCenter.current()) else {
    return "unknown"
  }
  switch settings.authorizationStatus {
  case .authorized:
    return "authorized"
  case .denied:
    return "denied"
  case .notDetermined:
    return "not_determined"
  case .provisional:
    return "provisional"
  case .ephemeral:
    return "ephemeral"
  @unknown default:
    return "unknown"
  }
}

func requestPermission() -> Bool {
  let center = UNUserNotificationCenter.current()
  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  center.requestAuthorization(options: [.alert, .sound, .badge]) { allowed, _ in
    granted = allowed
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + 30)
  return granted
}

func waitForDeliveredNotifications(_ center: UNUserNotificationCenter) -> [UNNotification] {
  let semaphore = DispatchSemaphore(value: 0)
  var resolved: [UNNotification] = []
  center.getDeliveredNotifications { notifications in
    resolved = notifications
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + 5)
  return resolved
}

func printDeliveredNotifications() {
  let delivered = waitForDeliveredNotifications(UNUserNotificationCenter.current())
  let rows = delivered.map { notification -> [String: Any] in
    let content = notification.request.content
    return [
      "identifier": notification.request.identifier,
      "threadIdentifier": content.threadIdentifier,
      "categoryIdentifier": content.categoryIdentifier,
      "title": content.title,
      "subtitle": content.subtitle,
      "body": content.body,
      "badge": content.badge?.intValue ?? 0,
      "eventId": content.userInfo["eventId"] as? String ?? "",
      "eventType": content.userInfo["eventType"] as? String ?? "",
      "sessionId": content.userInfo["sessionId"] as? String ?? "",
      "projectId": content.userInfo["projectId"] as? String ?? "",
      "notificationId": content.userInfo["notificationId"] as? String ?? "",
      "threadId": content.userInfo["threadId"] as? String ?? "",
    ]
  }
  printJsonObject([
    "count": rows.count,
    "notifications": rows,
  ])
}

func clearDeliveredNotifications() {
  let center = UNUserNotificationCenter.current()
  let identifiers = waitForDeliveredNotifications(center).map { $0.request.identifier }
  if identifiers.isEmpty {
    return
  }

  center.removeDeliveredNotifications(withIdentifiers: identifiers)
  NSApplication.shared.dockTile.badgeLabel = nil
  Thread.sleep(forTimeInterval: 0.5)
}

func decodePayload(_ base64: String) throws -> NotifyPayload {
  guard let data = Data(base64Encoded: base64) else {
    throw NSError(domain: appName, code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 payload"])
  }
  return try JSONDecoder().decode(NotifyPayload.self, from: data)
}

func fallbackNotificationId(_ eventId: String) -> String {
  return "\(eventId).\(UUID().uuidString)"
}

func fallbackThreadId() -> String {
  return "ao.notifications"
}

func sendNotification(_ payload: NotifyPayload) throws {
  let center = UNUserNotificationCenter.current()
  center.delegate = delegate

  var actionUrls: [String: String] = [:]
  var actionCallbacks: [String: String] = [:]
  let configuredUrlActions = (payload.actions ?? []).enumerated().compactMap { index, action -> UNNotificationAction? in
    guard action.url != nil || action.callbackEndpoint != nil else { return nil }
    let identifier = "ao.action.\(index)"
    if let url = action.url {
      actionUrls[identifier] = url
    }
    if let callbackEndpoint = action.callbackEndpoint {
      actionCallbacks[identifier] = callbackEndpoint
    }
    return UNNotificationAction(
      identifier: identifier,
      title: action.label,
      options: [.foreground]
    )
  }

  let categoryId: String?
  if configuredUrlActions.isEmpty {
    categoryId = nil
  } else {
    let id = "ao.event.\(payload.event.id)"
    let category = UNNotificationCategory(
      identifier: id,
      actions: configuredUrlActions,
      intentIdentifiers: [],
      options: []
    )
    center.setNotificationCategories([category])
    categoryId = id
  }

  let content = UNMutableNotificationContent()
  let threadId = payload.threadId ?? fallbackThreadId()
  content.title = payload.title
  if let subtitle = payload.subtitle {
    content.subtitle = subtitle
  }
  content.body = payload.body
  content.threadIdentifier = threadId
  if let categoryId = categoryId {
    content.categoryIdentifier = categoryId
  }
  content.badge = NSNumber(value: waitForDeliveredNotifications(center).count + 1)
  if payload.sound {
    content.sound = .default
  }

  var userInfo: [String: Any] = [
    "eventId": payload.event.id,
    "eventType": payload.event.type,
    "sessionId": payload.event.sessionId,
    "projectId": payload.event.projectId,
    "threadId": threadId,
    "actionUrls": actionUrls,
    "actionCallbacks": actionCallbacks,
  ]
  let requestId = payload.notificationId ?? fallbackNotificationId(payload.event.id)
  userInfo["notificationId"] = requestId
  if let defaultOpenUrl = payload.defaultOpenUrl {
    userInfo["defaultOpenUrl"] = defaultOpenUrl
  }
  content.userInfo = userInfo

  let request = UNNotificationRequest(identifier: requestId, content: content, trigger: nil)
  let semaphore = DispatchSemaphore(value: 0)
  var sendError: Error?
  center.add(request) { error in
    sendError = error
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + 5)
  if let sendError = sendError {
    throw sendError
  }
}

func runCommand(_ args: [String]) -> Int32 {
  let center = UNUserNotificationCenter.current()
  center.delegate = delegate

  guard let command = args.first else {
    RunLoop.current.run(until: Date().addingTimeInterval(5))
    return 0
  }

  do {
    switch command {
    case "--version-json":
      printJson([
        ("name", appName),
        ("version", appVersion),
        ("bundleId", bundleId),
      ])
      return 0
    case "--permission-status-json":
      let settings = waitForSettings(center)
      printJson([
        ("status", permissionStatus()),
        ("badge", settings.map { notificationSettingStatus($0.badgeSetting) } ?? "unknown"),
        ("bundleId", bundleId),
      ])
      return 0
    case "--delivered-json":
      printDeliveredNotifications()
      return 0
    case "--clear-delivered":
      clearDeliveredNotifications()
      printJson([
        ("cleared", "true"),
        ("bundleId", bundleId),
      ])
      return 0
    case "--request-permission":
      let granted = requestPermission()
      let settings = waitForSettings(center)
      printJson([
        ("status", granted ? "authorized" : permissionStatus()),
        ("badge", settings.map { notificationSettingStatus($0.badgeSetting) } ?? "unknown"),
        ("bundleId", bundleId),
      ])
      return granted ? 0 : 2
    case "--notify-base64":
      guard args.count >= 2 else {
        fputs("Missing --notify-base64 payload\n", stderr)
        return 64
      }
      let status = permissionStatus()
      if status == "not_determined" {
        _ = requestPermission()
      }
      try sendNotification(decodePayload(args[1]))
      return 0
    default:
      fputs("Unknown command: \(command)\n", stderr)
      return 64
    }
  } catch {
    fputs("\(error.localizedDescription)\n", stderr)
    return 1
  }
}

exit(runCommand(Array(CommandLine.arguments.dropFirst())))
