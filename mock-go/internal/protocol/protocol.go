package protocol

type Request struct {
    Type    string                 `json:"type"`
    ID      int                    `json:"id"`
    Command string                 `json:"command"`
    Args    map[string]any         `json:"args,omitempty"`
}

type Response struct {
    Type    string `json:"type"`
    ID      int    `json:"id"`
    Success bool   `json:"success"`
    Body    any    `json:"body,omitempty"`
    Message string `json:"message,omitempty"`
}

type Event struct {
    Type  string `json:"type"`
    Event string `json:"event"`
    Body  any    `json:"body,omitempty"`
}

func Ok(id int, body any) Response {
    return Response{Type: "response", ID: id, Success: true, Body: body}
}

func OkEmpty(id int) Response {
    return Response{Type: "response", ID: id, Success: true}
}

func Fail(id int, msg string) Response {
    return Response{Type: "response", ID: id, Success: false, Message: msg}
}

