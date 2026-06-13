package com.example.posture.controller;

import com.example.posture.dto.Result;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<Void> handleIllegalArgumentException(IllegalArgumentException exception) {
        return Result.fail(400, exception.getMessage());
    }

    @ExceptionHandler(IllegalStateException.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public Result<Void> handleIllegalStateException(IllegalStateException exception) {
        return Result.fail(500, exception.getMessage());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result<Void> handleHttpMessageNotReadable(HttpMessageNotReadableException exception) {
        Throwable root = exception.getMostSpecificCause();
        String detail = root.getMessage() != null ? root.getMessage() : root.getClass().getSimpleName();
        return Result.fail(400, "Request body parse error: " + detail);
    }

    @ExceptionHandler(UnsupportedOperationException.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public Result<Void> handleUnsupportedOperation(UnsupportedOperationException exception) {
        exception.printStackTrace();
        return Result.fail(500, exception.getMessage());
    }

    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public Result<Void> handleException(Exception exception) {
        exception.printStackTrace();
        String msg = exception.getMessage() != null ? exception.getMessage() : exception.getClass().getSimpleName();
        return Result.fail(500, msg);
    }
}
