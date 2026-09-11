import Foundation
import Security

enum Exit: Int32 {
    case usage = 40
    case invalidInput = 41
    case keychainFailure = 42
    case inputFailure = 43
    case notFound = 44
}

func fail(_ code: Exit, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    Foundation.exit(code.rawValue)
}

guard CommandLine.arguments.count == 4 else {
    fail(.usage, "KEYCHAIN_USAGE_INVALID")
}

let command = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]

let safeCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
func isSafeToken(_ value: String) -> Bool {
    return !value.isEmpty && value.count <= 180 && value.rangeOfCharacter(from: safeCharacters.inverted) == nil
}
guard isSafeToken(service), isSafeToken(account) else {
    fail(.invalidInput, "KEYCHAIN_IDENTIFIER_INVALID")
}

let baseQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
]

switch command {
case "set":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard !secret.isEmpty, secret.count <= 65_536 else {
        fail(.inputFailure, "KEYCHAIN_SECRET_INVALID")
    }
    let updateStatus = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: secret] as CFDictionary)
    if updateStatus == errSecItemNotFound {
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = secret
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            fail(.keychainFailure, "KEYCHAIN_WRITE_FAILED")
        }
    } else if updateStatus != errSecSuccess {
        fail(.keychainFailure, "KEYCHAIN_WRITE_FAILED")
    }
case "get":
    var query = baseQuery
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        fail(.notFound, "KEYCHAIN_ITEM_NOT_FOUND")
    }
    guard status == errSecSuccess, let secret = result as? Data else {
        fail(.keychainFailure, "KEYCHAIN_READ_FAILED")
    }
    FileHandle.standardOutput.write(secret)
case "has":
    var query = baseQuery
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecItemNotFound {
        fail(.notFound, "KEYCHAIN_ITEM_NOT_FOUND")
    }
    guard status == errSecSuccess else {
        fail(.keychainFailure, "KEYCHAIN_READ_FAILED")
    }
case "delete":
    let status = SecItemDelete(baseQuery as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail(.keychainFailure, "KEYCHAIN_DELETE_FAILED")
    }
default:
    fail(.usage, "KEYCHAIN_COMMAND_INVALID")
}
