# Managed components are ignored directories inside the outer source repository.
# Without a discovery ceiling, git apply silently skips component-relative paths
# and returns success. Keep Git in component-local filesystem mode instead.
function(stackchan_apply_managed_component_patch component_dir patch_file description)
    if(NOT EXISTS "${component_dir}/CMakeLists.txt" OR NOT EXISTS "${patch_file}")
        return()
    endif()

    get_filename_component(component_parent "${component_dir}" DIRECTORY)
    set(isolated_git "${CMAKE_COMMAND}" -E env
        --unset=GIT_DIR --unset=GIT_WORK_TREE
        "GIT_CEILING_DIRECTORIES=${component_parent}" "LC_ALL=C" git)
    execute_process(
        COMMAND ${isolated_git} apply --verbose --check "${patch_file}"
        WORKING_DIRECTORY "${component_dir}"
        RESULT_VARIABLE forward_result
        OUTPUT_VARIABLE forward_output
        ERROR_VARIABLE forward_error
    )
    if("${forward_output}${forward_error}" MATCHES "Skipped patch")
        message(FATAL_ERROR "${description}: Git skipped patch paths; refusing false success")
    endif()

    if(forward_result EQUAL 0)
        execute_process(
            COMMAND ${isolated_git} apply --verbose "${patch_file}"
            WORKING_DIRECTORY "${component_dir}"
            RESULT_VARIABLE apply_result
            OUTPUT_VARIABLE apply_output
            ERROR_VARIABLE apply_error
        )
        if(NOT apply_result EQUAL 0 OR "${apply_output}${apply_error}" MATCHES "Skipped patch")
            message(FATAL_ERROR "${description}: patch application failed\n${apply_output}${apply_error}")
        endif()
    endif()

    # Verify every hunk exists, both after application and on later configures.
    execute_process(
        COMMAND ${isolated_git} apply --verbose --reverse --check "${patch_file}"
        WORKING_DIRECTORY "${component_dir}"
        RESULT_VARIABLE reverse_result
        OUTPUT_VARIABLE reverse_output
        ERROR_VARIABLE reverse_error
    )
    if(NOT reverse_result EQUAL 0 OR "${reverse_output}${reverse_error}" MATCHES "Skipped patch")
        message(FATAL_ERROR
            "${description}: patch cannot be applied or verified in ${component_dir}\n"
            "Forward check:\n${forward_output}${forward_error}\n"
            "Reverse check:\n${reverse_output}${reverse_error}")
    endif()
    if(forward_result EQUAL 0)
        message(STATUS "Applied ${description} patch")
    else()
        message(STATUS "${description} patch already applied")
    endif()
endfunction()
