/* The Windows entrypoint owns process transport, never workflow execution. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static DWORD child_pid;
static BOOL cancel_requested;
static HANDLE runtime_process;
typedef struct {
  HANDLE read;
  HANDLE destination;
  BOOL machine_output;
} Stream;
static Stream output;
static Stream errors;
static volatile LONG output_failed;

/* A parent's Node pipe may use overlapped I/O. Keep the buffer and OVERLAPPED
   alive until completion, even when WriteFile returns ERROR_IO_PENDING. */
static BOOL write_bytes(HANDLE destination, const char *bytes, DWORD length, DWORD *written) {
  DWORD kind = GetFileType(destination);
  if (kind != FILE_TYPE_PIPE)
    return WriteFile(destination, bytes, length, written, NULL);
  OVERLAPPED operation;
  BOOL complete;
  DWORD error;
  ZeroMemory(&operation, sizeof(operation));
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!operation.hEvent) return FALSE;
  complete = WriteFile(destination, bytes, length, NULL, &operation);
  error = GetLastError();
  if (complete || error == ERROR_IO_PENDING) {
    complete = GetOverlappedResult(destination, &operation, written, TRUE);
    error = GetLastError();
  }
  CloseHandle(operation.hEvent);
  SetLastError(error);
  return complete;
}

static void diagnostic(const char *message) {
  DWORD written;
  HANDLE stream = GetStdHandle(STD_ERROR_HANDLE);
  if (stream && stream != INVALID_HANDLE_VALUE)
    write_bytes(stream, message, (DWORD)strlen(message), &written);
}

static void stream_error(Stream *stream, DWORD error) {
  if (stream->machine_output && error != ERROR_BROKEN_PIPE &&
      error != ERROR_NO_DATA && error != ERROR_PIPE_NOT_CONNECTED)
    InterlockedExchange(&output_failed, 1);
}

static BOOL deliver(Stream *stream, const char *bytes, DWORD length) {
  while (length) {
    DWORD written = 0;
    BOOL delivered = write_bytes(stream->destination, bytes, length, &written);
    if (!delivered || !written) {
      DWORD error = GetLastError();
      stream_error(stream, delivered ? ERROR_WRITE_FAULT : error);
      return FALSE;
    }
    bytes += written;
    length -= written;
  }
  return TRUE;
}

static DWORD WINAPI forward_stream(void *context) {
  Stream *stream = context;
  char buffer[16384];
  char prefix[2];
  DWORD prefix_length = 0;
  DWORD length;
  BOOL first = stream->machine_output;
  for (;;) {
    DWORD available = 0;
    if (!PeekNamedPipe(stream->read, NULL, 0, NULL, &available, NULL)) {
      stream_error(stream, GetLastError());
      break;
    }
    if (!available) {
      /* Electron enables stdio inheritance. An otherwise redirected background
         service can retain these native handles. The engine has already drained
         its workflow pipes before Electron exits; drain its buffered host output,
         then stop without waiting for unrelated inherited handles. */
      DWORD state = WaitForSingleObject(runtime_process, 10);
      if (state == WAIT_OBJECT_0) {
        if (!PeekNamedPipe(stream->read, NULL, 0, NULL, &available, NULL) || !available)
          break;
      } else if (state == WAIT_FAILED) {
        stream_error(stream, GetLastError());
        break;
      } else continue;
    }
    if (!ReadFile(stream->read, buffer,
                  available < sizeof(buffer) ? available : (DWORD)sizeof(buffer),
                  &length, NULL)) {
      stream_error(stream, GetLastError());
      break;
    }
    if (!length) break;
    DWORD offset = 0;
    if (first) {
      while (prefix_length < 2 && offset < length)
        prefix[prefix_length++] = buffer[offset++];
      if (prefix_length < 2) continue;
      first = FALSE;
      /* Electron BasicStartupComplete writes exactly CRLF before loading JS.
         Preserve every other byte, including subsequent leading whitespace. */
      if ((prefix[0] != '\r' || prefix[1] != '\n') && !deliver(stream, prefix, 2)) break;
    }
    if (!deliver(stream, buffer + offset, length - offset)) break;
  }
  if (first && prefix_length) deliver(stream, prefix, prefix_length);
  CloseHandle(stream->read);
  return 0;
}

static BOOL CALLBACK close_child_window(HWND window, LPARAM unused) {
  DWORD owner = 0;
  (void)unused;
  GetWindowThreadProcessId(window, &owner);
  if (owner == child_pid) PostMessageW(window, WM_CLOSE, 0, 0);
  return TRUE;
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_CLOSE) {
    cancel_requested = TRUE;
    EnumWindows(close_child_window, 0);
    return 0;
  }
  if (message == WM_TIMER && cancel_requested) {
    /* A close request received during startup must also reach a later window. */
    EnumWindows(close_child_window, 0);
    return 0;
  }
  return DefWindowProcW(window, message, wp, lp);
}

static const wchar_t *argument_tail(void) {
  const wchar_t *tail = GetCommandLineW();
  BOOL quoted = FALSE;
  while (*tail) {
    if (*tail == L'"') quoted = !quoted;
    else if (!quoted && (*tail == L' ' || *tail == L'\t')) break;
    ++tail;
  }
  return tail;
}

static BOOL inherit_stream(DWORD standard, DWORD access, HANDLE *destination) {
  HANDLE original = GetStdHandle(standard);
  SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
  if (!original || original == INVALID_HANDLE_VALUE) {
    *destination = CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               &security, OPEN_EXISTING, 0, NULL);
    return *destination != INVALID_HANDLE_VALUE;
  }
  return DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(),
                         destination, 0, TRUE, DUPLICATE_SAME_ACCESS);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, wchar_t *arguments, int show) {
  wchar_t executable[32768];
  wchar_t *separator;
  wchar_t *command = NULL;
  HANDLE output_write = NULL;
  HANDLE reader = NULL;
  HANDLE error_reader = NULL;
  HANDLE error_write = NULL;
  HANDLE job = NULL;
  HANDLE child_input = NULL;
  HWND window = NULL;
  DWORD exit_code = 70;
  DWORD path_length;
  const wchar_t *tail;
  size_t command_length;
  STARTUPINFOEXW startup;
  SIZE_T attribute_size = 0;
  HANDLE inherited[3];
  BOOL attributes_initialized = FALSE;
  PROCESS_INFORMATION child;
  SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  WNDCLASSW window_class;
  (void)previous;
  (void)arguments;
  (void)show;
  ZeroMemory(&child, sizeof(child));
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&limits, sizeof(limits));
  ZeroMemory(&window_class, sizeof(window_class));

  path_length = GetModuleFileNameW(NULL, executable, 32768);
  if (!path_length || path_length >= 32768) goto failed;
  separator = wcsrchr(executable, L'\\');
  if (!separator || (size_t)(separator - executable) + 24 >= 32768) goto failed;
  wcscpy(separator + 1, L"rune-gui-shell-bin.exe");
  tail = argument_tail();
  command_length = wcslen(executable) + wcslen(tail) + 3;
  if (command_length > 32767) goto failed;
  command = calloc(command_length, sizeof(wchar_t));
  if (!command) goto failed;
  swprintf(command, command_length, L"\"%ls\"%ls", executable, tail);

  output.machine_output = TRUE;
  output.destination = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!output.destination || output.destination == INVALID_HANDLE_VALUE)
    output.destination = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     NULL, OPEN_EXISTING, 0, NULL);
  if (output.destination == INVALID_HANDLE_VALUE) goto failed;
  errors.destination = GetStdHandle(STD_ERROR_HANDLE);
  if (!errors.destination || errors.destination == INVALID_HANDLE_VALUE)
    errors.destination = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     NULL, OPEN_EXISTING, 0, NULL);
  if (errors.destination == INVALID_HANDLE_VALUE) goto failed;
  if (!CreatePipe(&output.read, &output_write, &security, 0) ||
      !CreatePipe(&errors.read, &error_write, &security, 0)) goto failed;
  if (!SetHandleInformation(output.read, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(errors.read, HANDLE_FLAG_INHERIT, 0)) goto failed;

  job = CreateJobObjectW(NULL, NULL);
  if (!job) goto failed;
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    goto failed;

  window_class.lpfnWndProc = window_proc;
  window_class.hInstance = instance;
  window_class.lpszClassName = L"RuneProcessLauncher";
  if (!RegisterClassW(&window_class)) goto failed;
  window = CreateWindowExW(WS_EX_TOOLWINDOW, window_class.lpszClassName, L"RUNE", 0,
                           0, 0, 0, 0, NULL, NULL, instance, NULL);
  if (!window) goto failed;
  SetTimer(window, 1, 100, NULL);

  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  if (!inherit_stream(STD_INPUT_HANDLE, GENERIC_READ, &child_input)) goto failed;
  startup.StartupInfo.hStdInput = child_input;
  startup.StartupInfo.hStdOutput = output_write;
  startup.StartupInfo.hStdError = error_write;
  inherited[0] = child_input;
  inherited[1] = output_write;
  inherited[2] = error_write;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
  startup.lpAttributeList = calloc(1, attribute_size);
  if (!startup.lpAttributeList ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_size))
    goto failed;
  attributes_initialized = TRUE;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  inherited, sizeof(inherited), NULL, NULL)) goto failed;
  if (!CreateProcessW(executable, command, NULL, NULL, TRUE,
                      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                      NULL, NULL, &startup.StartupInfo, &child)) goto failed;
  child_pid = child.dwProcessId;
  runtime_process = child.hProcess;
  if (!AssignProcessToJobObject(job, child.hProcess)) goto failed;
  reader = CreateThread(NULL, 0, forward_stream, &output, 0, NULL);
  if (!reader) goto failed;
  error_reader = CreateThread(NULL, 0, forward_stream, &errors, 0, NULL);
  if (!error_reader) goto failed;
  if (ResumeThread(child.hThread) == (DWORD)-1) goto failed;
  CloseHandle(output_write);
  output_write = NULL;
  CloseHandle(error_write);
  error_write = NULL;
  CloseHandle(child.hThread);
  child.hThread = NULL;
  CloseHandle(child_input);
  child_input = NULL;

  for (;;) {
    DWORD state = MsgWaitForMultipleObjects(1, &child.hProcess, FALSE, INFINITE, QS_ALLINPUT);
    if (state == WAIT_OBJECT_0) break;
    if (state != WAIT_OBJECT_0 + 1) goto failed;
    MSG message;
    while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  if (!GetExitCodeProcess(child.hProcess, &exit_code)) exit_code = 70;
  /* Normal completion must not kill deliberately detached workflow services.
     The job only cleans up if the launcher itself is forcibly terminated. */
  limits.BasicLimitInformation.LimitFlags = 0;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    goto failed;
  CloseHandle(job);
  job = NULL;
  WaitForSingleObject(reader, INFINITE);
  WaitForSingleObject(error_reader, INFINITE);
  if (output_failed) {
    diagnostic("could not write the requested machine output to stdout\n");
    exit_code = 70;
  }
  goto cleanup;

failed:
  exit_code = 70;
  diagnostic("could not start the GUI runtime\n");
  if (child.hProcess) TerminateProcess(child.hProcess, 70);
cleanup:
  if (output_write) CloseHandle(output_write);
  if (error_write) CloseHandle(error_write);
  if (job) CloseHandle(job);
  if (reader) {
    WaitForSingleObject(reader, INFINITE);
    CloseHandle(reader);
  } else if (output.read) CloseHandle(output.read);
  if (error_reader) {
    WaitForSingleObject(error_reader, INFINITE);
    CloseHandle(error_reader);
  } else if (errors.read) CloseHandle(errors.read);
  if (child.hThread) CloseHandle(child.hThread);
  if (child.hProcess) CloseHandle(child.hProcess);
  if (child_input) CloseHandle(child_input);
  if (window) DestroyWindow(window);
  if (startup.lpAttributeList) {
    if (attributes_initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
    free(startup.lpAttributeList);
  }
  free(command);
  return (int)exit_code;
}
