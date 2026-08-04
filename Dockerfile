FROM golang:1.21-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /teatime .

FROM scratch
COPY --from=build /teatime /teatime
COPY static /static
# seeds a fresh named volume with the sample recipes
COPY data /data
EXPOSE 80
ENTRYPOINT ["/teatime", "-addr", ":80", "-data", "/data", "-static", "/static"]
