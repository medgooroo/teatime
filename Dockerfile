FROM golang:1.24-alpine AS build
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /teatime .

FROM scratch
# scratch has no trust store, so every HTTPS call — importing from the
# Guardian, fetching a recipe's original — fails to verify its certificate
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /teatime /teatime
COPY static /static
# No recipes are baked in: the data volume is the only source of truth for a
# deployment. Populate it with "Check for new recipes", and copy in anything
# hand-made separately.
EXPOSE 80
ENTRYPOINT ["/teatime", "-addr", ":80", "-data", "/data", "-static", "/static"]
