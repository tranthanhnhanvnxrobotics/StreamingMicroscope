################################################################################
# Automatically-generated file. Do not edit!
# Toolchain: GNU Tools for STM32 (13.3.rel1)
################################################################################

# Add inputs and outputs from these tool invocations to the build variables 
C_SRCS += \
../Core/App/uart_protocol/uart_protocol.c 

OBJS += \
./Core/App/uart_protocol/uart_protocol.o 

C_DEPS += \
./Core/App/uart_protocol/uart_protocol.d 


# Each subdirectory must supply rules for building sources it contributes
Core/App/uart_protocol/%.o Core/App/uart_protocol/%.su Core/App/uart_protocol/%.cyclo: ../Core/App/uart_protocol/%.c Core/App/uart_protocol/subdir.mk
	arm-none-eabi-gcc "$<" -mcpu=cortex-m4 -std=gnu11 -g3 -DDEBUG -DUSE_HAL_DRIVER -DSTM32F401xC -c -I../Core/Inc -I"D:/WEB/firmware/DoAnTotNghiep/StepMotor/Core/App/as5600" -I"D:/WEB/firmware/DoAnTotNghiep/StepMotor/Core/App/motor_map" -I"D:/WEB/firmware/DoAnTotNghiep/StepMotor/Core/App/motor_map" -I"D:/WEB/firmware/DoAnTotNghiep/StepMotor/Core/App/app_control" -I"D:/WEB/firmware/DoAnTotNghiep/StepMotor/Core/App/stepper_control" -I"D:/WEB/firmware/DoAnTotNghiep/StepMotor/Core/App/uart_protocol" -I../Drivers/STM32F4xx_HAL_Driver/Inc -I../Drivers/STM32F4xx_HAL_Driver/Inc/Legacy -I../Drivers/CMSIS/Device/ST/STM32F4xx/Include -I../Drivers/CMSIS/Include -I../Middlewares/Third_Party/FreeRTOS/Source/include -I../Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS_V2 -I../Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F -O0 -ffunction-sections -fdata-sections -Wall -fstack-usage -fcyclomatic-complexity -MMD -MP -MF"$(@:%.o=%.d)" -MT"$@" --specs=nano.specs -mfpu=fpv4-sp-d16 -mfloat-abi=hard -mthumb -o "$@"

clean: clean-Core-2f-App-2f-uart_protocol

clean-Core-2f-App-2f-uart_protocol:
	-$(RM) ./Core/App/uart_protocol/uart_protocol.cyclo ./Core/App/uart_protocol/uart_protocol.d ./Core/App/uart_protocol/uart_protocol.o ./Core/App/uart_protocol/uart_protocol.su

.PHONY: clean-Core-2f-App-2f-uart_protocol

